# =====================================================================
# Flask API for the GPT-2 + (Q)LoRA BoolQ True/False question generator (v1, single adapter)
#
# Inference only: loads the BEST model saved by the training script (adapter + tokenizer + meta.json
# in BEST_DIR) and exposes it over HTTP. Run the training script once with TRAIN = True first.
#
# Install:
#   pip install flask transformers peft torch pymupdf python-docx pytesseract pillow
#   (+ the Tesseract binary for OCR on images / scanned PDFs)
#
# Run:
#   python api.py                                   # http://localhost:5000
#   MODEL_DIR=/path/to/best PORT=8000 python api.py
#
# Endpoints:
#   GET  /health                  -> model status + meta
#   POST /extract                 -> multipart "file" -> extracted text
#   POST /question                -> JSON {"passage": "..."} -> one question + answer
#   POST /generate                -> JSON {"text": "...", "max_passages": 5, "passage_tokens": 200,
#                                          "only_valid": false} -> question + answer per passage
#   POST /generate-file           -> multipart "file" (+ same options as form fields) -> same as /generate
# =====================================================================
import contextlib
import json
import math
import os
import re
import tempfile
import threading
from pathlib import Path

import torch
from flask import Flask, jsonify, request
from peft import PeftModel
from transformers import AutoTokenizer, GPT2LMHeadModel

# ========== 0) Config ==========
BASE_DIR = Path(__file__).resolve().parent
BEST_DIR = os.environ.get("MODEL_DIR", str(BASE_DIR / "best"))
META_PATH = os.path.join(BEST_DIR, "meta.json")
HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "5003"))
MAX_UPLOAD_MB = int(os.environ.get("MAX_UPLOAD_MB", "20"))
MAX_PASSAGES_LIMIT = 30

HAS_CUDA = torch.cuda.is_available()
USE_BF16 = HAS_CUDA and torch.cuda.get_device_capability()[0] >= 8
COMPUTE_DTYPE = torch.bfloat16 if USE_BF16 else (torch.float16 if HAS_CUDA else torch.float32)
DEVICE = torch.device("cuda" if HAS_CUDA else "cpu")
if not HAS_CUDA:
    torch.set_num_threads(max(1, os.cpu_count() or 1))


def amp():
    """Mixed-precision context on GPU, no-op on CPU."""
    if HAS_CUDA:
        return torch.autocast(device_type="cuda", dtype=COMPUTE_DTYPE)
    return contextlib.nullcontext()


# ========== 1) Load best model + meta ==========
if not os.path.exists(os.path.join(BEST_DIR, "adapter_config.json")):
    raise FileNotFoundError(f"No saved best model in {BEST_DIR}. Run the training script once with TRAIN=True.")

META = {}
if os.path.exists(META_PATH):
    with open(META_PATH) as f:
        META = json.load(f)

THRESHOLD = float(META.get("threshold", 0.0))
BEST_CFG = META.get("generation_config", {"no_repeat_ngram_size": 3, "repetition_penalty": 1.05})
# Prompt sizes must match the ones used in training (stored in meta.json)
MAX_PROMPT_TOKENS = int(META.get("max_prompt_tokens", 512 if HAS_CUDA else 320))
MAX_NEW_TOKENS = int(META.get("max_new_tokens", 40))
NUM_BEAMS = int(META.get("num_beams", 4 if HAS_CUDA else 2))

try:
    tokenizer = AutoTokenizer.from_pretrained(BEST_DIR)
except Exception:
    tokenizer = AutoTokenizer.from_pretrained("gpt2")
tokenizer.pad_token = tokenizer.eos_token  # GPT-2 has no PAD token

_base = GPT2LMHeadModel.from_pretrained("gpt2")
_base.config.pad_token_id = tokenizer.pad_token_id
model = PeftModel.from_pretrained(_base, BEST_DIR).to(DEVICE)
model.eval()
model.config.use_cache = True
MAX_CONTEXT = model.config.n_positions  # 1024
print(f"Loaded best model from {BEST_DIR} on {DEVICE} | threshold {THRESHOLD:+.3f} | gen {BEST_CFG}")

TRUE_ID = tokenizer(" True", add_special_tokens=False)["input_ids"]
FALSE_ID = tokenizer(" False", add_special_tokens=False)["input_ids"]
assert len(TRUE_ID) == 1 and len(FALSE_ID) == 1
TRUE_ID, FALSE_ID = TRUE_ID[0], FALSE_ID[0]

# One request at a time on the model (generate() is not safe to run concurrently on one model)
MODEL_LOCK = threading.Lock()

# ========== 2) Helpers: normalize / validate / parse (same as training script) ==========
YES_NO_STARTERS = {
    "is", "are", "was", "were", "am",
    "do", "does", "did",
    "can", "could", "will", "would", "shall", "should",
    "has", "have", "had",
    "may", "might", "must",
}
STOPWORDS = {
    "the", "a", "an", "of", "in", "on", "at", "to", "for", "and", "or", "as", "by", "with",
    "from", "same", "there", "it", "its", "this", "that", "be", "been",
} | YES_NO_STARTERS


def normalize_question(q):
    q = " ".join(q.strip().split())
    q = q.rstrip(" .!?")
    q = q[:1].upper() + q[1:]
    return q + "?"


def is_valid_tf_question(q):
    if not q:
        return False
    q = q.strip()
    words = q.split()
    return (
        q.endswith("?")
        and q.count("?") == 1
        and len(words) >= 3
        and words[0].lower() in YES_NO_STARTERS
    )


def is_degenerate_question(q):
    content = [w for w in re.findall(r"[a-z0-9']+", q.lower()) if w not in STOPWORDS]
    if not content:
        return True
    return len(set(content)) / len(content) < 0.7


ANSWER_RE = re.compile(r"answer\s*:\s*(true|false)\b", re.IGNORECASE)


def parse_output(text):
    text = text.strip()
    m = ANSWER_RE.search(text)
    if m:
        q_part, answer, format_ok = text[:m.start()], m.group(1).lower() == "true", True
    else:
        q_part, answer, format_ok = re.split(r"answer\s*:", text, flags=re.IGNORECASE)[0], None, False
    q_part = re.sub(r"^\s*question\s*:\s*", "", q_part, flags=re.IGNORECASE)
    return " ".join(q_part.split()), answer, format_ok


# ========== 3) Prompt construction (must match training) ==========
INSTRUCTION = (
    "Generate exactly one True/False question based only on the passage. "
    "The question must be answerable from the passage."
)
HEAD_IDS = tokenizer(INSTRUCTION + "\n\nPassage:\n", add_special_tokens=False)["input_ids"]
TAIL_IDS = tokenizer("\n\nResponse:\n", add_special_tokens=False)["input_ids"]
PASSAGE_BUDGET = MAX_PROMPT_TOKENS - len(HEAD_IDS) - len(TAIL_IDS)


def build_prompt_ids(passage):
    passage_ids = tokenizer(
        passage.strip(), add_special_tokens=False, truncation=True, max_length=PASSAGE_BUDGET
    )["input_ids"]
    return HEAD_IDS + passage_ids + TAIL_IDS


def build_question_ids(question):
    return tokenizer(f"Question: {question}\nAnswer:", add_special_tokens=False)["input_ids"]


def left_pad(batch_ids):
    pad = tokenizer.pad_token_id
    max_len = max(len(p) for p in batch_ids)
    input_ids = torch.tensor([[pad] * (max_len - len(p)) + p for p in batch_ids], device=DEVICE)
    attention_mask = torch.tensor([[0] * (max_len - len(p)) + [1] * len(p) for p in batch_ids], device=DEVICE)
    return input_ids, attention_mask, max_len


# ========== 4) Inference ==========
@torch.no_grad()
def answer_score(passage, question):
    """score = log P(' True') - log P(' False') after 'Question: <q>\\nAnswer:'."""
    q_ids = build_question_ids(question if question else "empty?")[:MAX_NEW_TOKENS]
    input_ids, attention_mask, _ = left_pad([build_prompt_ids(passage) + q_ids])
    position_ids = (attention_mask.cumsum(-1) - 1).clamp(min=0)
    with amp():
        logits = model(input_ids=input_ids, attention_mask=attention_mask,
                       position_ids=position_ids).logits[:, -1, :].float()
    logp = torch.log_softmax(logits, dim=-1)
    return float(logp[0, TRUE_ID] - logp[0, FALSE_ID])


@torch.no_grad()
def generate_for_passage(passage, num_candidates=4):
    """Beam search -> first valid + non-degenerate candidate -> True/False by calibrated scoring."""
    input_ids, attention_mask, max_len = left_pad([build_prompt_ids(passage)])
    with amp():
        out = model.generate(
            input_ids=input_ids,
            attention_mask=attention_mask,
            max_new_tokens=MAX_NEW_TOKENS,
            num_beams=max(NUM_BEAMS, num_candidates),
            num_return_sequences=num_candidates,
            do_sample=False,
            early_stopping=True,
            pad_token_id=tokenizer.pad_token_id,
            eos_token_id=tokenizer.eos_token_id,
            use_cache=True,
            **BEST_CFG,
        )
    questions = [parse_output(tokenizer.decode(r[max_len:], skip_special_tokens=True))[0] for r in out]

    def rank(i):
        q = questions[i]
        ok = is_valid_tf_question(q)
        return (not (ok and not is_degenerate_question(q)), not ok, i)

    q = questions[min(range(len(questions)), key=rank)]
    valid = is_valid_tf_question(q)
    if q and not valid:
        q = normalize_question(q)
        valid = is_valid_tf_question(q)
    nondegen = valid and not is_degenerate_question(q)

    score = answer_score(passage, q)
    margin = score - THRESHOLD
    p_true = 1.0 / (1.0 + math.exp(-margin))
    return {
        "question": q,
        "answer": margin > 0,
        "confidence": round(max(p_true, 1 - p_true), 4),
        "score": round(score, 4),
        "valid": valid,
        "non_degenerate": nondegen,
    }


# ========== 5) Passage extraction: TXT / PDF / DOCX / IMAGE ==========
TEXT_EXT = {".txt", ".md", ".csv"}
PDF_EXT = {".pdf"}
DOCX_EXT = {".docx"}
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff", ".webp", ".gif"}
SUPPORTED_EXT = sorted(TEXT_EXT | PDF_EXT | DOCX_EXT | IMAGE_EXT)

# Tesseract binary: TESSERACT_CMD env var, else the default Windows install path, else rely on PATH
TESSERACT_CMD = os.environ.get("TESSERACT_CMD") or next(
    (p for p in (r"C:\Program Files\Tesseract-OCR\tesseract.exe",
                 r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe") if os.path.exists(p)), None)


def read_txt(path):
    raw = Path(path).read_bytes()
    for enc in ("utf-8-sig", "utf-8", "cp1256", "latin-1"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="ignore")


def ocr_image(img, lang="eng"):
    import pytesseract
    from PIL import ImageOps
    if TESSERACT_CMD:
        pytesseract.pytesseract.tesseract_cmd = TESSERACT_CMD
    img = ImageOps.exif_transpose(img).convert("L")
    if min(img.size) < 1000:
        scale = 1000 / min(img.size)
        img = img.resize((int(img.width * scale), int(img.height * scale)))
    img = ImageOps.autocontrast(img)
    return pytesseract.image_to_string(img, lang=lang, config="--psm 3")


def read_image(path, lang="eng"):
    from PIL import Image
    with Image.open(path) as img:
        img.seek(0)
        return ocr_image(img.copy(), lang=lang)


def read_pdf(path, lang="eng", ocr_min_chars=30):
    import pymupdf
    from PIL import Image
    pages = []
    with pymupdf.open(path) as doc:
        for page in doc:
            text = page.get_text("text")
            if len(text.strip()) < ocr_min_chars:
                pix = page.get_pixmap(dpi=300)
                img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
                text = ocr_image(img, lang=lang)
            pages.append(text)
    return "\n\n".join(pages)


def read_docx(path):
    import docx
    d = docx.Document(path)
    parts = [p.text for p in d.paragraphs]
    for table in d.tables:
        for row in table.rows:
            cells = [c.text.strip() for c in row.cells if c.text.strip()]
            if cells:
                parts.append(" | ".join(dict.fromkeys(cells)))
    return "\n\n".join(parts)


def clean_text(text):
    text = text.replace("\r\n", "\n").replace("\r", "\n").replace("\x0c", "\n\n")
    text = re.sub(r"(\w)-\n(\w)", r"\1\2", text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n[ \t]+", "\n", text)
    text = re.sub(r"(?<!\n)\n(?!\n)", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def extract_text(path, ocr_lang="eng"):
    ext = Path(path).suffix.lower()
    if ext in TEXT_EXT:
        text = read_txt(path)
    elif ext in PDF_EXT:
        text = read_pdf(path, lang=ocr_lang)
    elif ext in DOCX_EXT:
        text = read_docx(path)
    elif ext in IMAGE_EXT:
        text = read_image(path, lang=ocr_lang)
    elif ext == ".doc":
        raise ValueError("Old .doc format is not supported. Save it as .docx and upload again.")
    else:
        raise ValueError(f"Unsupported file type '{ext}'. Supported: {', '.join(SUPPORTED_EXT)}")
    return clean_text(text)


SENT_SPLIT_RE = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9\"'(\[])")


def n_tokens(text):
    return len(tokenizer(text, add_special_tokens=False)["input_ids"])


def split_into_passages(text, max_tokens=200, min_tokens=30):
    max_tokens = min(int(max_tokens), PASSAGE_BUDGET)
    units = []
    for para in re.split(r"\n\s*\n", text):
        para = " ".join(para.split())
        if not para:
            continue
        if n_tokens(para) <= max_tokens:
            units.append(para)
            continue
        for sent in SENT_SPLIT_RE.split(para):
            sent = sent.strip()
            if not sent:
                continue
            ids = tokenizer(sent, add_special_tokens=False)["input_ids"]
            if len(ids) <= max_tokens:
                units.append(sent)
            else:
                units += [tokenizer.decode(ids[i:i + max_tokens]).strip() for i in range(0, len(ids), max_tokens)]

    chunks, cur, cur_n = [], [], 0
    for u in units:
        n = n_tokens(u)
        if cur and cur_n + n > max_tokens:
            chunks.append(" ".join(cur))
            cur, cur_n = [], 0
        cur.append(u)
        cur_n += n
    if cur:
        chunks.append(" ".join(cur))
    good = [c for c in chunks if n_tokens(c) >= min_tokens]
    return good or chunks


# ========== 6) Request helpers ==========
class ApiError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.message = message
        self.status = status


def get_options(src):
    """Read generation options from a JSON body or form fields."""
    def to_bool(v):
        return v if isinstance(v, bool) else str(v).strip().lower() in ("1", "true", "yes", "on")

    try:
        max_passages = int(src.get("max_passages", 5))
        passage_tokens = int(src.get("passage_tokens", 200))
    except (TypeError, ValueError):
        raise ApiError("'max_passages' and 'passage_tokens' must be integers.")
    return {
        "max_passages": max(1, min(max_passages, MAX_PASSAGES_LIMIT)),
        "passage_tokens": max(80, min(passage_tokens, PASSAGE_BUDGET)),
        "only_valid": to_bool(src.get("only_valid", False)),
    }


def save_upload_and_extract(file_storage, ocr_lang="eng"):
    if file_storage is None or not file_storage.filename:
        raise ApiError("No file uploaded. Send it as multipart/form-data field 'file'.")
    ext = Path(file_storage.filename).suffix.lower()
    if ext not in SUPPORTED_EXT and ext != ".doc":
        raise ApiError(f"Unsupported file type '{ext}'. Supported: {', '.join(SUPPORTED_EXT)}")
    fd, tmp_path = tempfile.mkstemp(suffix=ext)
    os.close(fd)
    try:
        file_storage.save(tmp_path)
        try:
            text = extract_text(tmp_path, ocr_lang=ocr_lang)
        except ValueError as e:
            raise ApiError(str(e))
        except Exception as e:
            raise ApiError(f"Extraction failed: {e}", 500)
    finally:
        with contextlib.suppress(OSError):
            os.remove(tmp_path)
    if not text.strip():
        raise ApiError("No text found (for images/scans check OCR language and image quality).", 422)
    return text


def run_generation(text, max_passages, passage_tokens, only_valid):
    passages = split_into_passages(clean_text(text), max_tokens=passage_tokens)
    total = len(passages)
    passages = passages[:max_passages]
    results = []
    with MODEL_LOCK:
        for i, p in enumerate(passages):
            r = generate_for_passage(p)
            if only_valid and not r["non_degenerate"]:
                continue
            results.append({"index": i + 1, "passage": p, **r,
                            "answer_text": "True" if r["answer"] else "False"})
    return {
        "passages_found": total,
        "passages_processed": len(passages),
        "questions_returned": len(results),
        "threshold": THRESHOLD,
        "results": results,
    }


# ========== 7) Flask app ==========
app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_MB * 1024 * 1024
app.json.ensure_ascii = False

try:  # optional: allow calls from a browser frontend on another origin
    from flask_cors import CORS
    CORS(app)
except ImportError:
    pass


@app.errorhandler(ApiError)
def handle_api_error(e):
    return jsonify({"error": e.message}), e.status


@app.errorhandler(413)
def handle_too_large(_):
    return jsonify({"error": f"File too large (max {MAX_UPLOAD_MB} MB)."}), 413


@app.get("/health")
def health():
    return jsonify({
        "status": "ok",
        "device": str(DEVICE),
        "model_dir": BEST_DIR,
        "threshold": THRESHOLD,
        "generation_config": BEST_CFG,
        "max_prompt_tokens": MAX_PROMPT_TOKENS,
        "passage_budget": PASSAGE_BUDGET,
        "best_eval_loss": META.get("best_eval_loss"),
        "eval_metrics": META.get("eval_metrics"),
        "supported_files": SUPPORTED_EXT,
    })


@app.post("/extract")
def extract():
    text = save_upload_and_extract(request.files.get("file"), request.form.get("ocr_lang", "eng"))
    return jsonify({"text": text, "words": len(text.split())})


@app.post("/question")
def question():
    data = request.get_json(silent=True) or {}
    passage = (data.get("passage") or "").strip()
    if not passage:
        raise ApiError("JSON body must contain a non-empty 'passage'.")
    with MODEL_LOCK:
        r = generate_for_passage(passage)
    return jsonify({**r, "answer_text": "True" if r["answer"] else "False", "threshold": THRESHOLD})


@app.post("/generate")
def generate():
    data = request.get_json(silent=True) or {}
    text = (data.get("text") or "").strip()
    if not text:
        raise ApiError("JSON body must contain a non-empty 'text'.")
    return jsonify(run_generation(text, **get_options(data)))


@app.post("/generate-file")
def generate_file():
    text = save_upload_and_extract(request.files.get("file"), request.form.get("ocr_lang", "eng"))
    return jsonify(run_generation(text, **get_options(request.form)))


if __name__ == "__main__":
    # threaded=True is fine: MODEL_LOCK serializes access to the model
    app.run(host=HOST, port=PORT, debug=False, threaded=True)
