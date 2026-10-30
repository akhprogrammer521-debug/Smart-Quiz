"""
Document summarization for an ed-tech platform.

Pipeline: extract -> normalize -> chunk -> summarize chunks -> final summary.
Returns the original text, normalized text, and summary separately.
The original text must never be overwritten or deleted.
"""

import os
import logging
import shutil
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

from google import genai
from google.genai import errors as genai_errors
from google.genai import types
import httpx
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent / ".env")

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from ai_services.text_service import analyze_document_structure, normalize_text

# Model used for all Gemini calls
MODEL_NAME = "gemini-3.5-flash-lite"

# Target output size for summaries (~150-180 tokens)
MAX_OUTPUT_TOKENS = 800
GEMINI_TOTAL_TIMEOUT_SECONDS = 60
logger = logging.getLogger(__name__)


class EmptyDocumentError(ValueError):
    """Raised when extraction yields no readable content."""


class DocConverterUnavailableError(RuntimeError):
    """Raised when legacy Word conversion cannot be started."""


class DocumentConversionError(RuntimeError):
    """Raised when a legacy Word file cannot be converted."""


class DocumentDependencyUnavailableError(RuntimeError):
    """Raised when a local extraction dependency is unavailable."""


class GeminiConfigurationError(RuntimeError):
    """Raised when Gemini credentials are not configured."""


class GeminiUnavailableError(RuntimeError):
    """Raised when Gemini cannot complete a request or times out."""


class GeminiResponseError(ValueError):
    """Raised when Gemini returns an empty or malformed response."""


@dataclass(frozen=True)
class ExtractedDocument:
    """Extracted text plus structure hints available from its file format."""

    text: str
    page_boundaries: tuple[int, ...] = ()
    styled_headings: tuple[str, ...] = ()


def get_gemini_client(timeout_ms=GEMINI_TOTAL_TIMEOUT_SECONDS * 1000):
    """Create a Gemini client using GEMINI_API_KEY from the environment."""
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise GeminiConfigurationError("Summarization service is not configured.")
    return genai.Client(
        api_key=api_key,
        http_options=types.HttpOptions(
            timeout=timeout_ms,
            retry_options=types.HttpRetryOptions(attempts=1),
        ),
    )


def _extract_docx(path: Path) -> ExtractedDocument:
    from docx import Document

    document = Document(path)
    paragraphs = list(document.paragraphs)
    headings = []
    for paragraph in paragraphs:
        style = paragraph.style
        style_name = style.name.lower() if style is not None else ""
        style_id = style.style_id.lower() if style is not None else ""
        if paragraph.text.strip() and (
            style_id.startswith("heading")
            or style_name.startswith(("heading", "title", "العنوان", "عنوان"))
        ):
            headings.append(paragraph.text.strip())
    return ExtractedDocument("\n".join(paragraph.text for paragraph in paragraphs), styled_headings=tuple(headings))


def _find_libreoffice() -> str:
    configured = os.environ.get("LIBREOFFICE_PATH")
    if configured:
        if Path(configured).is_file():
            return configured
        raise DocConverterUnavailableError("LibreOffice is required to read .doc files.")

    found = shutil.which("soffice") or shutil.which("libreoffice")
    if found:
        return found

    for variable in ("PROGRAMFILES", "PROGRAMFILES(X86)"):
        root = os.environ.get(variable)
        if root:
            candidate = Path(root) / "LibreOffice" / "program" / "soffice.exe"
            if candidate.is_file():
                return str(candidate)
    raise DocConverterUnavailableError("LibreOffice is required to read .doc files.")


def _extract_doc(path: Path) -> ExtractedDocument:
    converter = _find_libreoffice()
    with tempfile.TemporaryDirectory() as directory:
        output_dir = Path(directory)
        profile = (output_dir / "profile").as_uri()
        try:
            result = subprocess.run(
                [converter, f"-env:UserInstallation={profile}", "--headless", "--convert-to", "docx", "--outdir", directory, str(path.resolve())],
                capture_output=True,
                text=True,
                timeout=60,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise DocumentConversionError("Could not convert this .doc file.") from exc

        converted = output_dir / f"{path.stem}.docx"
        if result.returncode != 0 or not converted.is_file():
            raise DocumentConversionError("Could not convert this .doc file.")
        return _extract_docx(converted)


def extract_document(path: str | Path) -> ExtractedDocument:
    """
    Extract text and available page/heading hints without modifying the source.
    Supports .txt, .pdf, .docx, .doc, and common image formats.
    """
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(f"File not found: {path}")

    suffix = path.suffix.lower()

    if suffix == ".txt":
        return ExtractedDocument(path.read_text(encoding="utf-8"))

    if suffix == ".pdf":
        import pymupdf

        text_parts = []
        page_starts = []
        offset = 0
        with pymupdf.open(path) as doc:
            for page in doc:
                if text_parts:
                    offset += 1  # The newline inserted between pages below.
                page_starts.append(offset)
                page_text = page.get_text()
                text_parts.append(page_text)
                offset += len(page_text)
        return ExtractedDocument("\n".join(text_parts), tuple(page_starts))

    if suffix == ".docx":
        return _extract_docx(path)

    if suffix == ".doc":
        return _extract_doc(path)

    if suffix in {".png", ".jpg", ".jpeg", ".bmp", ".tiff", ".tif", ".gif"}:
        try:
            from PIL import Image
            import pytesseract
        except ImportError as exc:
            raise DocumentDependencyUnavailableError(
                "Pillow and pytesseract are required for image OCR. "
                "Install them with: pip install Pillow pytesseract"
            ) from exc

        try:
            image = Image.open(path)
            return ExtractedDocument(pytesseract.image_to_string(image))
        except pytesseract.TesseractNotFoundError as exc:
            raise DocumentDependencyUnavailableError("Image OCR is not available on this server.") from exc

    raise ValueError(
        f"Unsupported file type: {suffix}. "
        "Supported types: .txt, .pdf, .docx, .doc, and common image formats."
    )


def extract_text_from_file(path: str | Path) -> str:
    """Backward-compatible text-only extraction helper."""
    return extract_document(path).text


def clean_text(text):
    """Backward-compatible name for the shared alizer."""
    return normalize_text(text)


def chunk_text(text, chunk_size=2000):
    """
    Split text into chunks by paragraphs.
    chunk_size is the max INPUT character size per chunk (default 2000).
    This is NOT an output token limit.
    """
    if not text:
        return []

    paragraphs = [p.strip() for p in text.split("\n\n") if p.strip()]
    if not paragraphs:
        # Fall back to single newlines if there are no blank-line paragraph breaks
        paragraphs = [p.strip() for p in text.split("\n") if p.strip()]

    chunks = []
    current = ""

    for paragraph in paragraphs:
        # If a single paragraph is larger than chunk_size, split it hard
        if len(paragraph) > chunk_size:
            if current:
                chunks.append(current)
                current = ""
            for i in range(0, len(paragraph), chunk_size):
                chunks.append(paragraph[i : i + chunk_size])
            continue

        candidate = paragraph if not current else current + "\n\n" + paragraph
        if len(candidate) <= chunk_size:
            current = candidate
        else:
            chunks.append(current)
            current = paragraph

    if current:
        chunks.append(current)

    return chunks


def _remaining_timeout_ms(deadline):
    remaining_ms = int((deadline - time.monotonic()) * 1000)
    if remaining_ms <= 0:
        raise GeminiUnavailableError("Gemini summarization timed out.")
    return remaining_ms


def _generate_text(prompt, timeout_ms):
    """Run one plain-text Gemini request and return validated text."""
    try:
        client = get_gemini_client(timeout_ms=timeout_ms)
        response = client.models.generate_content(
            model=MODEL_NAME,
            contents=prompt,
            config=types.GenerateContentConfig(
                max_output_tokens=MAX_OUTPUT_TOKENS,
                automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
            ),
        )
    except GeminiConfigurationError:
        raise
    except (genai_errors.APIError, httpx.HTTPError, TimeoutError) as exc:
        print(f"Gemini error: {type(exc).__name__}: {exc}")
        raise GeminiUnavailableError("Gemini request failed.") from exc

    try:
        text = response.text
    except (AttributeError, TypeError, ValueError) as exc:
        raise GeminiResponseError("Gemini returned a malformed response.") from exc
    if not isinstance(text, str) or not text.strip():
        raise GeminiResponseError("Gemini returned an empty response.")
    return text.strip()


def summarize_chunk(chunk: str, headings: Sequence[str] = (), timeout_ms=GEMINI_TOTAL_TIMEOUT_SECONDS * 1000):
    heading_context = ""
    if headings:
        heading_context = "Document headings (context only; use the text below for facts):\n" + "\n".join(headings[:20]) + "\n\n"

    prompt = (
        "You are helping students by summarizing educational material.\n"
        "Summarize the following text clearly and concisely.\n"
        "IMPORTANT rules:\n"
        "- Keep key educational facts, formulas, and definitions.\n"
        "- Do not invent information that is not in the text.\n"
        "- Write in plain, readable language for learners.\n"
        "- CRITICAL: Do NOT use LaTeX, markdown math formatting, or backslashes. Write all formulas in plain text (e.g., CO2, H2O).\n"
        "- Aim for a concise summary of about 150-200 words.\n\n"
        f"{heading_context}Text:\n{chunk}"
    )

    return _generate_text(prompt, timeout_ms)


def generate_final_summary(intermediate_summaries, timeout_ms=GEMINI_TOTAL_TIMEOUT_SECONDS * 1000):
    if not intermediate_summaries:
        return ""

    if len(intermediate_summaries) == 1:
        return intermediate_summaries[0]

    joined = "\n\n---\n\n".join(intermediate_summaries)

    prompt = (
        "You are helping students by creating one final study summary.\n"
        "Below are intermediate summaries of different parts of the same document.\n"
        "Combine them into ONE coherent, well-organized final summary.\n"
        "IMPORTANT rules:\n"
        "- Do not simply paste the parts together.\n"
        "- Merge overlapping ideas and remove repetition.\n"
        "- Keep key educational facts, formulas, and definitions.\n"
        "- Do not invent information.\n"
        "- CRITICAL: Do NOT use LaTeX, markdown math formatting, or backslashes. Write all formulas in plain text (e.g., CO2, H2O).\n"
        "- Return only the summary, without an introduction or conclusion.\n"
        "- Do not use phrases such as 'Here is a summary' or 'In short'.\n"
        "- Do not repeat information or explain beyond the source text.\n"
        "- For a short text, write 1-2 concise sentences. For a longer text, write a concise paragraph or short bullet points.\n"
        f"Intermediate summaries:\n{joined}"
    )

    return _generate_text(prompt, timeout_ms)


def summarize_document(path):
    """
    Full pipeline: extract -> normalize -> chunk -> summarize -> final summary.
    Returns a dict with original_text, normalized_text, summary, and num_chunks.
    The original_text is preserved for teammates (e.g. question generation).
    """
    extracted = extract_document(path)
    original_text = extracted.text
    structure = analyze_document_structure(
        original_text,
        page_boundaries=extracted.page_boundaries,
        styled_headings=extracted.styled_headings,
    )
    normalized_text = normalize_text(structure.educational_text)
    if not normalized_text:
        raise EmptyDocumentError("No readable text was found in the document.")
    chunks = chunk_text(normalized_text, chunk_size=2000)

    deadline = time.monotonic() + GEMINI_TOTAL_TIMEOUT_SECONDS
    intermediate_summaries = []
    for chunk in chunks:
        intermediate_summaries.append(
            summarize_chunk(
                chunk,
                structure.headings,
                timeout_ms=_remaining_timeout_ms(deadline),
            )
        )

    final_summary = generate_final_summary(
        intermediate_summaries,
        timeout_ms=_remaining_timeout_ms(deadline),
    )

    return {
        "original_text": original_text,
        "normalized_text": normalized_text,
        "summary": final_summary,
        "num_chunks": len(chunks),
        "structure": {
            "page_numbers": list(structure.page_numbers),
            "page_boundaries": list(structure.page_boundaries),
            "headings": list(structure.headings),
            "table_of_contents": [
                {"title": entry.title, "page_number": entry.page_number}
                for entry in structure.table_of_contents
            ],
        },
    }


if __name__ == "__main__":
    import sys

    # Default demo file; you can also pass a path: python summarization.py path/to/file.txt
    demo_path = sys.argv[1] if len(sys.argv) > 1 else "test_files/sample.txt"

    print("=" * 60)
    print(f"Running summarization pipeline on: {demo_path}")
    print("=" * 60)

    print("\nExtracting text...")
    original_text = extract_text_from_file(demo_path)
    snippet = original_text[:300].replace("\n", " ")
    print(f"  Extracted {len(original_text)} characters.")
    print(f"  Snippet: {snippet}...")

    print("\nCleaning text...")
    cleaned = clean_text(original_text)
    print(f"  Cleaned length: {len(cleaned)} characters.")

    print("\nSplitting into chunks...")
    chunks = chunk_text(cleaned, chunk_size=2000)
    print(f"Splitting into {len(chunks)} chunks...")

    intermediate_summaries = []
    for i, chunk in enumerate(chunks, start=1):
        print(f"\nSummarizing chunk {i}...")
        summary = summarize_chunk(chunk)
        intermediate_summaries.append(summary)
        print(f"  Intermediate summary {i}:\n{summary}")

    print("\nGenerating final summary...")
    final_summary = generate_final_summary(intermediate_summaries)
    print(f"\nFinal result:\n{final_summary}")
    print("\nDone.")
