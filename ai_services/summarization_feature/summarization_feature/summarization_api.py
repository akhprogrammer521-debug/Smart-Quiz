"""
Simple Flask API for document summarization.
Route stays thin: receive file -> call summarize_document -> return JSON -> clean up.
"""

import os
import hmac
import logging
import tempfile
from pathlib import Path

from flask import Flask, jsonify, request, render_template

from summarization import (
    DocConverterUnavailableError,
    DocumentDependencyUnavailableError,
    DocumentConversionError,
    EmptyDocumentError,
    GeminiConfigurationError,
    GeminiResponseError,
    GeminiUnavailableError,
    summarize_document,
)
from grading import grade_short_answer

app = Flask(__name__)
logger = logging.getLogger(__name__)

# Allowed upload extensions (same formats as extract_text_from_file)
ALLOWED_EXTENSIONS = {
    ".txt",
    ".pdf",
    ".docx",
    ".doc",
    ".png",
    ".jpg",
    ".jpeg",
    ".bmp",
    ".tiff",
    ".tif",
    ".gif",
}


def allowed_file(filename):
    """Return True if the filename has a supported extension."""
    return Path(filename).suffix.lower() in ALLOWED_EXTENSIONS


def _internal_request_is_authorized():
    """Authenticate server-to-server grading calls with a shared secret."""
    expected = os.environ.get("AI_SERVICE_INTERNAL_KEY", "")
    supplied = request.headers.get("X-Internal-Api-Key", "")
    return bool(expected) and bool(supplied) and hmac.compare_digest(expected, supplied)


def _validated_summary_result(result):
    """Validate the service result before serializing a successful response."""
    if not isinstance(result, dict):
        raise GeminiResponseError("Summarization returned an invalid result.")
    for field in ("original_text", "normalized_text", "summary"):
        value = result.get(field)
        if not isinstance(value, str) or not value.strip():
            raise GeminiResponseError("Summarization returned an invalid result.")
    num_chunks = result.get("num_chunks")
    if not isinstance(num_chunks, int) or isinstance(num_chunks, bool) or num_chunks < 1:
        raise GeminiResponseError("Summarization returned an invalid result.")
    return result


# NEW: Serve the frontend webpage
@app.route("/")
def home():
    return render_template("index.html")


@app.route("/api/summarize", methods=["POST"])
def summarize():
    """
    POST /api/summarize
    Input: multipart/form-data with a 'file' field.
    Output: JSON with success, filename, original_text, normalized_text, summary, num_chunks.
    """
    if "file" not in request.files:
        return jsonify({"success": False, "error": "No file field in request."}), 400

    uploaded = request.files["file"]
    if not uploaded or uploaded.filename == "":
        return jsonify({"success": False, "error": "No file selected."}), 400

    if not allowed_file(uploaded.filename):
        return jsonify(
            {
                "success": False,
                "error": (
                    "Unsupported file type. "
                    "Use .txt, .pdf, .docx, .doc, or a common image format."
                ),
            }
        ), 400

    filename = Path(uploaded.filename).name
    temp_path = None

    try:
        # Save upload to a temporary file, then process it
        suffix = Path(uploaded.filename).suffix.lower()
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            temp_path = tmp.name
            uploaded.save(temp_path)

        result = _validated_summary_result(summarize_document(temp_path))

        return jsonify(
            {
                "success": True,
                "filename": filename,
                "original_text": result["original_text"],
                "normalized_text": result["normalized_text"],
                "summary": result["summary"],
                "num_chunks": result["num_chunks"],
                "structure": result.get("structure", {}),
            }
        )
    except EmptyDocumentError:
        return jsonify({"success": False, "error": "No readable text was found in the document."}), 422
    except DocConverterUnavailableError:
        return jsonify({
            "success": False,
            "code": "LIBREOFFICE_REQUIRED",
            "error": "LibreOffice must be installed to read .doc files.",
        }), 503
    except DocumentConversionError:
        return jsonify({"success": False, "error": "Could not read this .doc file."}), 422
    except GeminiResponseError:
        return jsonify({"success": False, "error": "Gemini returned an empty or invalid summary."}), 502
    except (GeminiConfigurationError, GeminiUnavailableError, DocumentDependencyUnavailableError):
        return jsonify({"success": False, "error": "Summarization service is unavailable."}), 503
    except Exception as exc:
        logger.exception("Unexpected summarization failure: %s", type(exc).__name__)
        return jsonify({"success": False, "error": "Could not summarize this document."}), 500
    finally:
        # Always clean up the temporary uploaded file
        if temp_path and os.path.exists(temp_path):
            try:
                os.remove(temp_path)
            except OSError as exc:
                logger.warning("Could not remove a temporary summarization file: %s", type(exc).__name__)


@app.route("/api/grade-short-answer", methods=["POST"])
def grade_answer():
    """Grade one short answer for the trusted Next.js server."""
    if not os.environ.get("AI_SERVICE_INTERNAL_KEY"):
        return jsonify({"success": False, "error": "Internal grading is not configured."}), 503
    if not _internal_request_is_authorized():
        return jsonify({"success": False, "error": "Unauthorized."}), 401

    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"success": False, "error": "A JSON request body is required."}), 400

    fields = {
        "question": data.get("question"),
        "student_answer": data.get("student_answer"),
        "difficulty": data.get("difficulty"),
        "source_text": data.get("source_text"),
    }
    if any(not isinstance(value, str) or not value.strip() for value in fields.values()):
        return jsonify({"success": False, "error": "All grading fields are required."}), 400
    if len(fields["question"]) > 10000 or len(fields["student_answer"]) > 5000:
        return jsonify({"success": False, "error": "The question or answer is too long."}), 413

    try:
        result = grade_short_answer(
            fields["question"].strip(),
            fields["student_answer"].strip(),
            fields["difficulty"].strip().upper(),
            fields["source_text"].strip(),
        )
        return jsonify({"success": True, **result})
    except RuntimeError:
        return jsonify({"success": False, "error": "Grading service is unavailable."}), 503
    except Exception:
        return jsonify({"success": False, "error": "Could not grade this answer."}), 500


if __name__ == "__main__":
    # Run the API locally for development / manual testing
    app.run(host="0.0.0.0", port=5000, debug=False)
