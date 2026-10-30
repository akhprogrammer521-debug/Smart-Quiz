import os
import re
import sys
from functools import lru_cache
from pathlib import Path

import torch
from flask import Flask, jsonify, request
from transformers import AutoModelForSeq2SeqLM, AutoTokenizer

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from ai_services.text_service import normalize_text

# ---------------------------------------------------------------------------
# الإعدادات
# ---------------------------------------------------------------------------

BASE_DIR = Path(__file__).resolve().parent
MODEL_PATH = Path(os.getenv("MODEL_PATH", str(BASE_DIR / "model" / "flan_t5_mcq_final")))
PREFIX = "Generate a multiple-choice question based on this context: "  # نفس الـ prefix بتاع التدريب
MAX_INPUT_LEN = 512
MAX_NEW_TOKENS = 128

device = "cuda" if torch.cuda.is_available() else "cpu"

def model_weights_available() -> bool:
    """Check for trained weights without downloading a base model."""
    patterns = ("model.safetensors", "pytorch_model.bin", "model-*.safetensors", "pytorch_model-*.bin")
    return any(next(MODEL_PATH.glob(pattern), None) is not None for pattern in patterns)


@lru_cache(maxsize=1)
def load_model():
    """Load the trained MCQ model once when generation is first requested."""
    if not model_weights_available():
        raise FileNotFoundError("Trained MCQ model weights are required.")
    tokenizer = AutoTokenizer.from_pretrained(str(MODEL_PATH), local_files_only=True)
    model = AutoModelForSeq2SeqLM.from_pretrained(str(MODEL_PATH), local_files_only=True).to(device)
    model.eval()
    return model, tokenizer

app = Flask(__name__)
app.config["JSON_AS_ASCII"] = False  # عشان العربي يظهر صح في الـ JSON


# ---------------------------------------------------------------------------
# تحويل مخرجات الموديل لشكل منظم
# ---------------------------------------------------------------------------
def parse_mcq(text: str) -> dict:
    """
    T5 tokenizer بيحول الـ newlines لمسافات، فالمخرج بيبقى غالبًا:
    "QUESTION: ... OPTIONS: A) ... B) ... C) ... D) ..."
    """
    m = re.search(r"QUESTION:\s*(.*?)\s*OPTIONS:\s*(.*)", text, flags=re.S)
    if not m:
        return {"question": text.strip(), "options": []}

    question, options_str = m.group(1).strip(), m.group(2).strip()

    parts = re.split(r"(?:^|\s)([A-Z])\)\s*", options_str)
    # parts = ['', 'A', 'text', 'B', 'text', ...]
    options = []
    for i in range(1, len(parts) - 1, 2):
        options.append({"label": parts[i], "text": parts[i + 1].strip()})

    return {"question": question, "options": options}


def generate_mcq(context: str, num_beams: int = 4, num_return_sequences: int = 1,
                 do_sample: bool = False, temperature: float = 1.0, top_p: float = 0.95):
    """Generate MCQs from text already normalized by the request handler."""
    model, tokenizer = load_model()
    inputs = tokenizer(
        PREFIX + context,
        return_tensors="pt",
        max_length=MAX_INPUT_LEN,
        truncation=True,
    ).to(device)

    gen_kwargs = dict(
        max_new_tokens=MAX_NEW_TOKENS,
        no_repeat_ngram_size=3,
        num_return_sequences=num_return_sequences,
    )
    if do_sample:
        gen_kwargs.update(do_sample=True, temperature=temperature, top_p=top_p)
    else:
        gen_kwargs.update(num_beams=max(num_beams, num_return_sequences))

    with torch.no_grad():
        outputs = model.generate(**inputs, **gen_kwargs)

    results = []
    for out in tokenizer.batch_decode(outputs, skip_special_tokens=True):
        parsed = parse_mcq(out)
        parsed["raw"] = out
        results.append(parsed)
    return results


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------
@app.get("/health")
def health():
    if not model_weights_available():
        return jsonify({"status": "unavailable", "error": "Trained MCQ model weights are required."}), 503
    return jsonify({"status": "ok", "device": device})


@app.post("/generate")
def generate():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "Expected a JSON object."}), 400
    context = data.get("context", "")

    if not isinstance(context, str):
        return jsonify({"error": "The 'context' field must be text."}), 400

    normalized_text = normalize_text(context)
    if not normalized_text:
        return jsonify({"error": "الحقل 'context' مطلوب"}), 400

    try:
        n = int(data.get("num_questions", 1))
        n = max(1, min(n, 5))
        num_beams = int(data.get("num_beams", 4))
        do_sample = bool(data.get("do_sample", False))
        temperature = float(data.get("temperature", 1.0))
        top_p = float(data.get("top_p", 0.95))
    except (TypeError, ValueError):
        return jsonify({"error": "Invalid generation options."}), 400

    try:
        results = generate_mcq(
            normalized_text,
            num_beams=num_beams,
            num_return_sequences=n,
            do_sample=do_sample,
            temperature=temperature,
            top_p=top_p,
        )
    except FileNotFoundError:
        return jsonify({"error": "Trained MCQ model weights are required."}), 503
    except Exception:
        return jsonify({"error": "MCQ generation is unavailable."}), 500

    return jsonify({"context": context, "normalized_text": normalized_text, "results": results, "questions": results})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", 5000)), debug=False)
