# =====================================================================
# GPT-2 + (Q)LoRA on BoolQ: generate one True/False question + its answer
# + Class-imbalance handling (oversampling, weighted loss, calibrated threshold, balanced metrics)
# + BEST MODEL saving (eval_loss tracking, load_best_model_at_end, early stopping, meta.json)
# + Passage extraction from TXT / PDF (incl. scanned via OCR) / DOCX / IMAGE (OCR)
# + Gradio GUI (upload file or paste text -> passages -> question + answer per passage)
#
# Works on GPU AND CPU:
#   GPU (T4/L4/A100) -> QLoRA 4-bit (if bitsandbytes is installed), fp16/bf16, full dataset
#   CPU              -> plain LoRA fp32, smaller subsets (training on CPU is slow)
#
# Modes:
#   TRAIN = True  -> train, keep the best checkpoint, calibrate, evaluate, save to BEST_DIR, launch GUI
#   TRAIN = False -> load the saved best model from BEST_DIR and launch GUI only (no training)
# =====================================================================

# %% ---------------------------------------------------------------
# CELL 0 - INSTALL (run ONCE, then Runtime > Restart session, then run CELL 1)
# -------------------------------------------------------------------
# !apt-get -qq install -y tesseract-ocr > /dev/null
# !pip install -q -U transformers peft accelerate datasets evaluate rouge_score bert_score sacrebleu
# !pip install -q -U bitsandbytes          # optional: only used on GPU (QLoRA)
# !pip install -q pymupdf python-docx pytesseract pillow gradio
# !pip uninstall -y torchvision torchaudio
#
# Do NOT upgrade pandas (breaks google-colab).
# After this cell finishes: Runtime > Restart session.

# %% ---------------------------------------------------------------
# CELL 1 - MAIN SCRIPT
# -------------------------------------------------------------------
import contextlib
import inspect
import json
import math
import os
import re
import sys
from collections import Counter
from pathlib import Path

# Shared text normalizer (ai_services/text_service). Find the project root (the folder
# that contains "ai_services/") starting from the working directory, then import it.
for _p in (Path.cwd(), *Path.cwd().parents):
    if (_p / "ai_services").is_dir():
        sys.path.insert(0, str(_p))
        break
from ai_services.text_service import normalize_text

import numpy as np
import pandas as pd
import torch
import torch.nn.functional as F
from tqdm.auto import tqdm
from datasets import load_dataset, concatenate_datasets
from transformers import (
    AutoTokenizer,
    GPT2LMHeadModel,
    BitsAndBytesConfig,
    TrainingArguments,
    Trainer,
    EarlyStoppingCallback,
    set_seed,
)
from peft import LoraConfig, PeftModel, get_peft_model, prepare_model_for_kbit_training
from sklearn.metrics import (
    accuracy_score,
    balanced_accuracy_score,
    f1_score,
    recall_score,
    confusion_matrix,
)

# ========== 0) Setup (GPU or CPU) ==========
TRAIN = True                  # False -> skip training, load best model from BEST_DIR, open GUI
SAVE_TO_DRIVE = False         # True -> best model survives Colab restarts (Google Drive)
WANT_4BIT = True              # QLoRA on GPU if bitsandbytes is available; ignored on CPU

SEED = 42
set_seed(SEED)

HAS_CUDA = torch.cuda.is_available()
try:
    import bitsandbytes  # noqa: F401
    HAS_BNB = True
except Exception:
    HAS_BNB = False

USE_4BIT = WANT_4BIT and HAS_CUDA and HAS_BNB
USE_BF16 = HAS_CUDA and torch.cuda.get_device_capability()[0] >= 8   # A100/L4 -> bf16
USE_FP16 = HAS_CUDA and not USE_BF16                                 # T4 -> fp16
COMPUTE_DTYPE = torch.bfloat16 if USE_BF16 else (torch.float16 if HAS_CUDA else torch.float32)

if HAS_CUDA:
    print(f"GPU: {torch.cuda.get_device_name(0)} | 4-bit QLoRA: {USE_4BIT} | dtype: {COMPUTE_DTYPE}")
else:
    torch.set_num_threads(max(1, os.cpu_count() or 1))
    print("⚠️ No GPU found -> running on CPU with plain LoRA (fp32) and reduced data sizes.\n"
          "   For full training in Colab: Runtime > Change runtime type > T4 GPU, then rerun.")


def amp():
    """Mixed-precision context on GPU, no-op on CPU."""
    if HAS_CUDA:
        return torch.autocast(device_type="cuda", dtype=COMPUTE_DTYPE)
    return contextlib.nullcontext()


# Sizes: full on GPU, reduced on CPU (so it finishes in reasonable time)
if HAS_CUDA:
    MAX_TRAIN_SAMPLES = None          # use all BoolQ train
    EPOCHS, BATCH, ACCUM = 6, 32, 8    # CUDA OOM -> BATCH, ACCUM = 1, 16
    N_TUNE, N_EVAL, TRAIN_EVAL_SIZE = 300, 500, 500
    NUM_BEAMS, GEN_BATCH_SIZE = 4, 32
    MAX_PROMPT_TOKENS = 512
else:
    MAX_TRAIN_SAMPLES = 1000          # raise if you have time; CPU is ~50-100x slower
    EPOCHS, BATCH, ACCUM = 1, 4, 4
    N_TUNE, N_EVAL, TRAIN_EVAL_SIZE = 100, 150, 100
    NUM_BEAMS, GEN_BATCH_SIZE = 2, 8
    MAX_PROMPT_TOKENS = 320

BALANCE_MODE = "oversample"   # "oversample" | "undersample" | "none"
ANSWER_LOSS_WEIGHT = 5.0      # extra weight on the single True/False token

if SAVE_TO_DRIVE:
    from google.colab import drive
    drive.mount("/content/drive")
    OUTPUT_ROOT = "/content/drive/MyDrive/gpt2-boolq-qlora"
else:
    OUTPUT_ROOT = "./gpt2-boolq-qlora"
CKPT_DIR = f"{OUTPUT_ROOT}/checkpoints"
BEST_DIR = f"{OUTPUT_ROOT}/best"          # adapter + tokenizer + meta.json of the BEST model
META_PATH = f"{BEST_DIR}/meta.json"
os.makedirs(BEST_DIR, exist_ok=True)


def save_meta(**kw):
    """Merge keys into meta.json (threshold, generation config, metrics, best checkpoint...)."""
    meta = {}
    if os.path.exists(META_PATH):
        with open(META_PATH) as f:
            meta = json.load(f)
    meta.update(kw)
    with open(META_PATH, "w") as f:
        json.dump(meta, f, indent=2, default=lambda o: o.item() if hasattr(o, "item") else str(o))
    return meta


# ========== 1) Dataset ==========
ds = load_dataset("google/boolq")
print(ds)
print("Train dist     :", Counter(ds["train"]["answer"]))
print("Validation dist:", Counter(ds["validation"]["answer"]))

# ========== 2) Tokenizer + model ==========
tokenizer = AutoTokenizer.from_pretrained("gpt2")
tokenizer.pad_token = tokenizer.eos_token  # GPT-2 has no PAD token

BNB_CONFIG = BitsAndBytesConfig(
    load_in_4bit=True,
    bnb_4bit_quant_type="nf4",
    bnb_4bit_compute_dtype=COMPUTE_DTYPE,
    bnb_4bit_use_double_quant=True,
) if USE_4BIT else None


def load_base_model():
    kw = {}
    if HAS_CUDA:
        kw["device_map"] = "auto"
    if BNB_CONFIG is not None:
        kw["quantization_config"] = BNB_CONFIG
    m = GPT2LMHeadModel.from_pretrained("gpt2", **kw)
    if not HAS_CUDA:
        m = m.to("cpu").float()
    m.config.pad_token_id = tokenizer.pad_token_id
    return m


if TRAIN:
    model = load_base_model()
    if USE_4BIT:
        model = prepare_model_for_kbit_training(
            model,
            use_gradient_checkpointing=True,
            gradient_checkpointing_kwargs={"use_reentrant": False},
        )
    else:
        model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
        model.enable_input_require_grads()

    lora_config = LoraConfig(
        r=16,
        lora_alpha=32,
        lora_dropout=0.05,
        bias="none",
        task_type="CAUSAL_LM",
        target_modules=["c_attn", "c_proj", "c_fc"],
        fan_in_fan_out=True,  # GPT-2 uses Conv1D layers
    )
    model = get_peft_model(model, lora_config)
    model.print_trainable_parameters()
else:
    if not os.path.exists(os.path.join(BEST_DIR, "adapter_config.json")):
        raise FileNotFoundError(f"No saved best model in {BEST_DIR}. Run once with TRAIN=True.")
    model = PeftModel.from_pretrained(load_base_model(), BEST_DIR)
    model.eval()
    print(f"Loaded best model from {BEST_DIR}")

DEVICE = next(model.parameters()).device
MAX_CONTEXT = model.config.n_positions  # 1024
print("Model device:", DEVICE)

TRUE_ID = tokenizer(" True", add_special_tokens=False)["input_ids"]
FALSE_ID = tokenizer(" False", add_special_tokens=False)["input_ids"]
assert len(TRUE_ID) == 1 and len(FALSE_ID) == 1
TRUE_ID, FALSE_ID = TRUE_ID[0], FALSE_ID[0]

# ========== 3) Helpers: normalize / validate / parse ==========
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
    q = normalize_text(q)  # shared normalizer replaces the old whitespace collapsing
    q = q.rstrip(" .!?")
    q = q[:1].upper() + q[1:]
    return q + "?"


def is_valid_tf_question(q):
    """Surface check only: ends with a single '?', >= 3 words, starts with an auxiliary/modal."""
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
    """Catches tautologies like 'Is scar the same as scar?' (repeated content words)."""
    content = [w for w in re.findall(r"[a-z0-9']+", q.lower()) if w not in STOPWORDS]
    if not content:
        return True
    return len(set(content)) / len(content) < 0.7


ANSWER_RE = re.compile(r"answer\s*:\s*(true|false)\b", re.IGNORECASE)


def parse_output(text):
    """Returns (question, answer, format_ok). Ignores anything after the first Answer."""
    text = text.strip()
    m = ANSWER_RE.search(text)
    if m:
        q_part, answer, format_ok = text[:m.start()], m.group(1).lower() == "true", True
    else:
        q_part, answer, format_ok = re.split(r"answer\s*:", text, flags=re.IGNORECASE)[0], None, False
    q_part = re.sub(r"^\s*question\s*:\s*", "", q_part, flags=re.IGNORECASE)
    return " ".join(q_part.split()), answer, format_ok


# ========== 4) Splits (no overlap) ==========
# [0, N_TUNE)                -> tuning: generation config + answer THRESHOLD calibration
# [N_TUNE, N_TUNE+N_EVAL)    -> final evaluation
# next TRAIN_EVAL_SIZE       -> eval loss during training (used to pick the BEST checkpoint)
validation = ds["validation"]
TUNE_END = min(N_TUNE, len(validation))
EVAL_END = min(TUNE_END + N_EVAL, len(validation))
TRAIN_EVAL_END = min(EVAL_END + TRAIN_EVAL_SIZE, len(validation))

tune_subset = validation.select(range(0, TUNE_END))
eval_subset = validation.select(range(TUNE_END, EVAL_END))
train_eval_subset = validation.select(range(EVAL_END, TRAIN_EVAL_END))
print(f"Split -> tune: {len(tune_subset)} {dict(Counter(tune_subset['answer']))} | "
      f"eval: {len(eval_subset)} {dict(Counter(eval_subset['answer']))} | "
      f"train-time eval: {len(train_eval_subset)}")

# ========== 5) Prompt / target construction ==========
INSTRUCTION = (
    "Generate exactly one True/False question based only on the passage. "
    "The question must be answerable from the passage."
)

MAX_NEW_TOKENS = 40
MAX_TARGET_TOKENS = MAX_NEW_TOKENS
assert MAX_PROMPT_TOKENS + MAX_TARGET_TOKENS <= MAX_CONTEXT

HEAD_IDS = tokenizer(INSTRUCTION + "\n\nPassage:\n", add_special_tokens=False)["input_ids"]
TAIL_IDS = tokenizer("\n\nResponse:\n", add_special_tokens=False)["input_ids"]
PASSAGE_BUDGET = MAX_PROMPT_TOKENS - len(HEAD_IDS) - len(TAIL_IDS)
assert PASSAGE_BUDGET > 100


def build_prompt_ids(example):
    passage_ids = tokenizer(
        normalize_text(example["passage"]),
        add_special_tokens=False,
        truncation=True,
        max_length=PASSAGE_BUDGET,
    )["input_ids"]
    return HEAD_IDS + passage_ids + TAIL_IDS


def build_question_ids(question):
    """'Question: <q>\\nAnswer:'. Same tokens in training, scoring and teacher forcing."""
    return tokenizer(f"Question: {question}\nAnswer:", add_special_tokens=False)["input_ids"]


def keep_example(example):
    q = normalize_question(example["question"])
    n_target = len(build_question_ids(q)) + 2  # + answer token + eos
    return n_target <= MAX_TARGET_TOKENS and is_valid_tf_question(q)


def tokenize_example(example, class_w):
    prompt_ids = build_prompt_ids(example)
    q_ids = build_question_ids(normalize_question(example["question"]))
    ans_id = TRUE_ID if example["answer"] else FALSE_ID
    target_ids = q_ids + [ans_id, tokenizer.eos_token_id]

    ans_w = ANSWER_LOSS_WEIGHT * class_w[bool(example["answer"])]
    loss_weights = [0.0] * len(prompt_ids) + [1.0] * len(q_ids) + [ans_w] + [1.0]
    return {
        "input_ids": prompt_ids + target_ids,
        "attention_mask": [1] * (len(prompt_ids) + len(target_ids)),
        "labels": [-100] * len(prompt_ids) + target_ids,
        "loss_weights": loss_weights,
    }


# ========== 6) (A) Rebalance TRAIN data ==========
def balance_dataset(dataset, mode, seed=SEED):
    if mode == "none":
        return dataset.shuffle(seed=seed)
    pos = dataset.filter(lambda x: x["answer"])
    neg = dataset.filter(lambda x: not x["answer"])
    big, small = (pos, neg) if len(pos) >= len(neg) else (neg, pos)
    if mode == "undersample":
        big = big.shuffle(seed=seed).select(range(len(small)))
    elif mode == "oversample":
        reps, rem = divmod(len(big), len(small))
        parts = [small] * reps
        if rem:
            parts.append(small.shuffle(seed=seed).select(range(rem)))
        small = concatenate_datasets(parts)
    else:
        raise ValueError(mode)
    return concatenate_datasets([big, small]).shuffle(seed=seed)


def class_weights(labels):
    """Inverse-frequency weights, normalized so a balanced set gives 1.0 / 1.0."""
    c = Counter(bool(x) for x in labels)
    n = sum(c.values())
    return {k: n / (2 * c[k]) for k in (True, False)}


# ========== 7) Collator ==========
class CausalLMDataCollator:
    def __init__(self, tokenizer, pad_to_multiple_of=8):
        self.tokenizer = tokenizer
        self.pad_to_multiple_of = pad_to_multiple_of

    def __call__(self, features):
        max_len = max(len(x["input_ids"]) for x in features)
        if self.pad_to_multiple_of:
            m = self.pad_to_multiple_of
            max_len = ((max_len + m - 1) // m) * m
        batch = {"input_ids": [], "attention_mask": [], "labels": [], "loss_weights": []}
        for x in features:
            pad_len = max_len - len(x["input_ids"])
            batch["input_ids"].append(x["input_ids"] + [self.tokenizer.pad_token_id] * pad_len)
            batch["attention_mask"].append(x["attention_mask"] + [0] * pad_len)
            batch["labels"].append(x["labels"] + [-100] * pad_len)
            batch["loss_weights"].append(x["loss_weights"] + [0.0] * pad_len)
        return {
            "input_ids": torch.tensor(batch["input_ids"], dtype=torch.long),
            "attention_mask": torch.tensor(batch["attention_mask"], dtype=torch.long),
            "labels": torch.tensor(batch["labels"], dtype=torch.long),
            "loss_weights": torch.tensor(batch["loss_weights"], dtype=torch.float),
        }


# ========== 8) (B) Weighted-loss Trainer + BEST-MODEL training ==========
class WeightedLossTrainer(Trainer):
    """Token-weighted causal LM loss: sum(w * CE) / sum(w) over target tokens."""

    def compute_loss(self, model, inputs, return_outputs=False, num_items_in_batch=None):
        labels = inputs.pop("labels")
        weights = inputs.pop("loss_weights")
        outputs = model(input_ids=inputs["input_ids"], attention_mask=inputs["attention_mask"])
        logits = outputs.logits[:, :-1, :].float()
        tgt = labels[:, 1:]
        w = weights[:, 1:].to(logits.device)
        ce = F.cross_entropy(
            logits.reshape(-1, logits.size(-1)), tgt.reshape(-1), ignore_index=-100, reduction="none"
        ).view_as(tgt)
        w = w * (tgt != -100)
        loss = (ce * w).sum() / w.sum().clamp(min=1e-8)
        return (loss, outputs) if return_outputs else loss


if TRAIN:
    train_raw = ds["train"].filter(keep_example)
    if MAX_TRAIN_SAMPLES is not None and len(train_raw) > MAX_TRAIN_SAMPLES:
        train_raw = train_raw.shuffle(seed=SEED).select(range(MAX_TRAIN_SAMPLES))
    print(f"Train after validity filter: {len(train_raw)} {dict(Counter(train_raw['answer']))}")

    train_bal = balance_dataset(train_raw, BALANCE_MODE)
    TRAIN_CLASS_W = class_weights(train_bal["answer"])
    print(f"Train after balancing ({BALANCE_MODE}): {len(train_bal)} {dict(Counter(train_bal['answer']))}")
    print("Answer-token class weights:", {k: round(v, 3) for k, v in TRAIN_CLASS_W.items()})

    tokenized_train = train_bal.map(
        tokenize_example, fn_kwargs={"class_w": TRAIN_CLASS_W}, remove_columns=train_bal.column_names
    )
    val_small_raw = train_eval_subset.filter(keep_example)
    tokenized_val_small = val_small_raw.map(
        tokenize_example, fn_kwargs={"class_w": {True: 1.0, False: 1.0}},
        remove_columns=val_small_raw.column_names,
    )

    _ex = tokenized_train[0]
    _n_prompt = sum(1 for l in _ex["labels"] if l == -100)
    assert _ex["labels"][_n_prompt:] == _ex["input_ids"][_n_prompt:]
    assert _ex["labels"][-2] in (TRUE_ID, FALSE_ID) and _ex["labels"][-1] == tokenizer.eos_token_id
    assert max(len(x) for x in tokenized_train["input_ids"]) <= MAX_CONTEXT
    print("Target used for loss:\n" + tokenizer.decode(_ex["labels"][_n_prompt:]))

    total_steps = math.ceil(len(tokenized_train) / (BATCH * ACCUM)) * EPOCHS
    warmup_steps = max(1, int(0.03 * total_steps))
    EVAL_STEPS = max(10, min(250, total_steps // 6))  # ~6+ evals regardless of dataset size
    print(f"Total optimizer steps: {total_steps} | eval/save every {EVAL_STEPS} steps")

    _eval_key = ("eval_strategy" if "eval_strategy" in inspect.signature(TrainingArguments.__init__).parameters
                 else "evaluation_strategy")

    training_args = TrainingArguments(
        output_dir=CKPT_DIR,
        num_train_epochs=EPOCHS,
        per_device_train_batch_size=BATCH,
        per_device_eval_batch_size=BATCH,
        gradient_accumulation_steps=ACCUM,
        learning_rate=2e-4,
        warmup_steps=warmup_steps,
        lr_scheduler_type="cosine",
        fp16=USE_FP16,
        bf16=USE_BF16,
        logging_steps=max(1, min(50, EVAL_STEPS // 2)),
        eval_steps=EVAL_STEPS,
        save_strategy="steps",
        save_steps=EVAL_STEPS,            # must match eval_steps for load_best_model_at_end
        save_total_limit=2,               # the best checkpoint is always kept on top of this
        load_best_model_at_end=True,      # restore the BEST checkpoint after training
        metric_for_best_model="eval_loss",
        greater_is_better=False,
        label_names=["labels"],           # PEFT model: otherwise eval_loss is never computed
        prediction_loss_only=True,
        report_to="none",
        remove_unused_columns=False,
        dataloader_pin_memory=HAS_CUDA,
        seed=SEED,
        **{_eval_key: "steps"},
    )

    trainer = WeightedLossTrainer(
        model=model,
        args=training_args,
        train_dataset=tokenized_train,
        eval_dataset=tokenized_val_small,
        data_collator=CausalLMDataCollator(tokenizer, pad_to_multiple_of=8),
        callbacks=[EarlyStoppingCallback(early_stopping_patience=3)],
    )
    trainer.model_accepts_loss_kwargs = False

    model.config.use_cache = False
    trainer.train()

    print(f"Best checkpoint: {trainer.state.best_model_checkpoint} | best eval_loss: {trainer.state.best_metric}")
    model.save_pretrained(BEST_DIR)
    tokenizer.save_pretrained(BEST_DIR)
    save_meta(best_checkpoint=trainer.state.best_model_checkpoint,
              best_eval_loss=trainer.state.best_metric,
              global_step=trainer.state.global_step,
              device="cuda" if HAS_CUDA else "cpu", use_4bit=USE_4BIT,
              balance_mode=BALANCE_MODE, answer_loss_weight=ANSWER_LOSS_WEIGHT,
              max_prompt_tokens=MAX_PROMPT_TOKENS, max_new_tokens=MAX_NEW_TOKENS)
    print(f"Saved best model -> {BEST_DIR}")

model.eval()
model.config.use_cache = True
DEVICE = next(model.parameters()).device


# ========== 9) Batched helpers (left padding) ==========
def left_pad(batch_ids):
    pad = tokenizer.pad_token_id
    max_len = max(len(p) for p in batch_ids)
    input_ids = torch.tensor([[pad] * (max_len - len(p)) + p for p in batch_ids], device=DEVICE)
    attention_mask = torch.tensor([[0] * (max_len - len(p)) + [1] * len(p) for p in batch_ids], device=DEVICE)
    return input_ids, attention_mask, max_len


@torch.no_grad()
def generate_responses(examples, no_repeat_ngram_size=0, repetition_penalty=1.05,
                       num_beams=NUM_BEAMS, batch_size=GEN_BATCH_SIZE, desc="Generating"):
    prompts = [build_prompt_ids(ex) for ex in examples]
    order = sorted(range(len(prompts)), key=lambda i: len(prompts[i]))
    results = [None] * len(prompts)
    for start in tqdm(range(0, len(order), batch_size), desc=desc, leave=False):
        idx = order[start:start + batch_size]
        input_ids, attention_mask, max_len = left_pad([prompts[i] for i in idx])
        assert max_len + MAX_NEW_TOKENS <= MAX_CONTEXT
        with amp():
            output = model.generate(
                input_ids=input_ids,
                attention_mask=attention_mask,
                max_new_tokens=MAX_NEW_TOKENS,
                num_beams=num_beams,
                no_repeat_ngram_size=no_repeat_ngram_size,
                repetition_penalty=repetition_penalty,
                do_sample=False,
                early_stopping=True,
                pad_token_id=tokenizer.pad_token_id,
                eos_token_id=tokenizer.eos_token_id,
                use_cache=True,
            )
        for row, i in zip(output, idx):
            results[i] = tokenizer.decode(row[max_len:], skip_special_tokens=True).strip()
    return results


@torch.no_grad()
def answer_scores(examples, questions, batch_size=GEN_BATCH_SIZE, use_adapter=True, desc="Scoring"):
    """(C) score = log P(' True') - log P(' False') after 'Question: <q>\\nAnswer:'."""
    seqs = []
    for ex, q in zip(examples, questions):
        q_ids = build_question_ids(q if q else "empty?")[:MAX_NEW_TOKENS]
        seqs.append(build_prompt_ids(ex) + q_ids)
    order = sorted(range(len(seqs)), key=lambda i: len(seqs[i]))
    scores = np.zeros(len(seqs), dtype=np.float32)

    def _run():
        for start in tqdm(range(0, len(order), batch_size), desc=desc, leave=False):
            idx = order[start:start + batch_size]
            input_ids, attention_mask, _ = left_pad([seqs[i] for i in idx])
            position_ids = (attention_mask.cumsum(-1) - 1).clamp(min=0)
            with amp():
                logits = model(input_ids=input_ids, attention_mask=attention_mask,
                               position_ids=position_ids).logits[:, -1, :].float()
            logp = torch.log_softmax(logits, dim=-1)
            s = (logp[:, TRUE_ID] - logp[:, FALSE_ID]).cpu().numpy()
            for j, i in enumerate(idx):
                scores[i] = s[j]

    if use_adapter:
        _run()
    else:
        with model.disable_adapter():
            _run()
    return scores


def calibrate_threshold(scores, labels):
    """Pick the threshold that maximizes BALANCED accuracy on the tuning split."""
    labels = np.asarray(labels, dtype=bool)
    s = np.sort(np.unique(scores))
    candidates = np.concatenate([[s[0] - 1e-3], (s[:-1] + s[1:]) / 2, [s[-1] + 1e-3], [0.0]])
    best_t, best_b = 0.0, -1.0
    for t in candidates:
        b = balanced_accuracy_score(labels, scores > t)
        if b > best_b + 1e-9:
            best_t, best_b = float(t), b
    return best_t, best_b


# ========== 10) (D) Imbalance-aware metrics ==========
def pct(x, n):
    return 100.0 * x / n if n else 0.0


def mean(xs):
    return sum(xs) / len(xs) if xs else 0.0


def cls_report(y_true, y_pred, name):
    y_true = np.asarray(y_true, dtype=bool)
    y_pred = np.asarray(y_pred, dtype=bool)
    tn, fp, fn, tp = confusion_matrix(y_true, y_pred, labels=[False, True]).ravel()
    return {
        "method": name,
        "accuracy": accuracy_score(y_true, y_pred),
        "balanced_acc": balanced_accuracy_score(y_true, y_pred),
        "macro_f1": f1_score(y_true, y_pred, average="macro", zero_division=0),
        "recall_True": recall_score(y_true, y_pred, pos_label=True, zero_division=0),
        "recall_False": recall_score(y_true, y_pred, pos_label=False, zero_division=0),
        "pred_True": int(y_pred.sum()),
        "pred_False": int((~y_pred).sum()),
        "TP/FN/FP/TN": f"{tp}/{fn}/{fp}/{tn}",
    }


def analyze(raw_outputs):
    parsed = [parse_output(t) for t in raw_outputs]
    questions = [q for q, _, _ in parsed]
    answers = [a for _, a, _ in parsed]
    fmt = [f for _, _, f in parsed]
    valid = [is_valid_tf_question(q) for q in questions]
    nondegen = [v and not is_degenerate_question(q) for q, v in zip(questions, valid)]
    return questions, answers, fmt, valid, nondegen


def safe_texts(texts):
    return [t if t else "empty" for t in texts]


# ========== 11-14) Calibration + generation tuning + final evaluation (TRAIN mode only) ==========
if TRAIN:
    import evaluate
    bleu = evaluate.load("bleu")
    rouge = evaluate.load("rouge")
    bertscore = evaluate.load("bertscore")

    N = len(eval_subset)
    tune_refs = [normalize_question(ex["question"]) for ex in tune_subset]
    tune_labels = [ex["answer"] for ex in tune_subset]
    ref_questions = [normalize_question(ex["question"]) for ex in eval_subset]
    ref_answers = [ex["answer"] for ex in eval_subset]

    # ---- 11) Calibrate answer threshold ----
    tune_scores = answer_scores(tune_subset, tune_refs, desc="Tune scores (fine-tuned)")
    THRESHOLD, tune_bacc = calibrate_threshold(tune_scores, tune_labels)
    print(f"Calibrated threshold (fine-tuned): {THRESHOLD:.3f} | tune balanced acc: {tune_bacc:.3f}")

    tune_scores_zs = answer_scores(tune_subset, tune_refs, use_adapter=False, desc="Tune scores (zero-shot)")
    THRESHOLD_ZS, _ = calibrate_threshold(tune_scores_zs, tune_labels)

    # ---- 12) Generation-settings comparison ----
    GEN_CONFIGS = [
        {"no_repeat_ngram_size": 0, "repetition_penalty": 1.05},
        {"no_repeat_ngram_size": 6, "repetition_penalty": 1.05},
        {"no_repeat_ngram_size": 3, "repetition_penalty": 1.05},
    ]
    if not HAS_CUDA:
        GEN_CONFIGS = GEN_CONFIGS[:2]  # save time on CPU
    rows = []
    for cfg in GEN_CONFIGS:
        outs = generate_responses(tune_subset, desc=f"Tune {cfg}", **cfg)
        qs, _, fmt, valid, nondegen = analyze(outs)
        r = rouge.compute(predictions=safe_texts(qs), references=tune_refs)
        rows.append({**cfg,
                     "format_%": pct(sum(fmt), len(qs)),
                     "valid_tf_%": pct(sum(valid), len(qs)),
                     "non_degenerate_%": pct(sum(nondegen), len(qs)),
                     "rougeL": r["rougeL"]})
    tune_df = pd.DataFrame(rows)
    print(tune_df.round(3).to_string(index=False))

    best_idx = max(range(len(rows)), key=lambda i: (rows[i]["non_degenerate_%"], rows[i]["format_%"],
                                                     round(rows[i]["rougeL"], 2)))
    BEST_CFG = GEN_CONFIGS[best_idx]
    print("Selected generation config:", BEST_CFG)

    save_meta(threshold=THRESHOLD, tune_balanced_acc=tune_bacc, generation_config=BEST_CFG,
              num_beams=NUM_BEAMS)

    # ---- 13) Final evaluation ----
    raw_outputs = generate_responses(eval_subset, desc="Final generation", **BEST_CFG)
    pred_questions, gen_answers, format_flags, valid_tf_flags, nondegen_flags = analyze(raw_outputs)

    gen_q_scores = answer_scores(eval_subset, pred_questions, desc="Scoring generated Qs")
    scored_answers = (gen_q_scores > THRESHOLD).tolist()

    tf_scores = answer_scores(eval_subset, ref_questions, desc="Teacher-forced (fine-tuned)")
    tf_scores_zs = answer_scores(eval_subset, ref_questions, use_adapter=False, desc="Teacher-forced (zero-shot)")

    bleu_result = bleu.compute(predictions=safe_texts(pred_questions), references=[[r] for r in ref_questions])
    rouge_result = rouge.compute(predictions=safe_texts(pred_questions), references=ref_questions)
    bs_device = "cuda" if HAS_CUDA else "cpu"
    try:
        bert_result = bertscore.compute(predictions=safe_texts(pred_questions), references=ref_questions,
                                        model_type="distilbert-base-uncased", lang="en",
                                        rescale_with_baseline=True, device=bs_device)
        bert_note = "(rescaled with baseline)"
    except Exception as e:
        print("BERTScore rescaling unavailable, using raw scores:", e)
        bert_result = bertscore.compute(predictions=safe_texts(pred_questions), references=ref_questions,
                                        model_type="distilbert-base-uncased", lang="en", device=bs_device)
        bert_note = "(raw, not rescaled: values are inflated)"

    print("=" * 78)
    print("[1] FORMAT VALIDITY")
    print(f"  Answer format accuracy          : {pct(sum(format_flags), N):.1f}%")
    print(f"  Syntactically valid TF question : {pct(sum(valid_tf_flags), N):.1f}%  (surface check only)")
    print(f"  Valid AND non-degenerate        : {pct(sum(nondegen_flags), N):.1f}%")

    print("\n[2] LINGUISTIC SIMILARITY to BoolQ reference question (not a correctness measure)")
    print(f"  BLEU    : {bleu_result['bleu']:.4f}")
    print(f"  ROUGE-1 : {rouge_result['rouge1']:.4f} | ROUGE-2 : {rouge_result['rouge2']:.4f} | "
          f"ROUGE-L : {rouge_result['rougeL']:.4f}")
    print(f"  BERTScore P/R/F1 {bert_note}: {mean(bert_result['precision']):.4f} / "
          f"{mean(bert_result['recall']):.4f} / {mean(bert_result['f1']):.4f}")

    print("\n[3] ANSWER QUALITY (class-imbalance aware). Eval dist:", dict(Counter(ref_answers)))
    majority = Counter(tune_labels).most_common(1)[0][0]
    report_rows = [
        cls_report(ref_answers, [majority] * N, f"Majority baseline (always {majority})"),
        cls_report(ref_answers, tf_scores_zs > THRESHOLD_ZS, "Zero-shot GPT-2, teacher-forced, calibrated"),
        cls_report(ref_answers, tf_scores > 0.0, "Fine-tuned, teacher-forced, threshold=0"),
        cls_report(ref_answers, tf_scores > THRESHOLD, "Fine-tuned, teacher-forced, calibrated"),
    ]
    report_df = pd.DataFrame(report_rows)
    print(report_df.round(3).to_string(index=False))
    print("  -> Headline metric: BALANCED ACCURACY / MACRO-F1.")

    print("\n[4] ANSWERS TO GENERATED QUESTIONS (no gold label exists for these)")
    print(f"  Beam-generated answer dist    : {dict(Counter(a for a in gen_answers if a is not None))}")
    print(f"  Calibrated scored answer dist : {dict(Counter(scored_answers))}")
    print("=" * 78)

    save_meta(eval_metrics=report_rows[-1],
              eval_generation={"format_%": pct(sum(format_flags), N),
                               "valid_tf_%": pct(sum(valid_tf_flags), N),
                               "non_degenerate_%": pct(sum(nondegen_flags), N),
                               "rougeL": rouge_result["rougeL"]})

    # ---- 14) Examples + CSV ----
    for i in range(min(10, N)):
        print("PASSAGE:", eval_subset[i]["passage"][:300].replace("\n", " "), "...")
        print("REFERENCE Q / A      :", ref_questions[i], "/", ref_answers[i])
        print("TEACHER-FORCED ANSWER:", bool(tf_scores[i] > THRESHOLD), f"(score {tf_scores[i]:+.2f})")
        print("GENERATED QUESTION   :", pred_questions[i])
        print("GENERATED ANSWER     :", scored_answers[i],
              f"(score {gen_q_scores[i]:+.2f}, beam said {gen_answers[i]})")
        print("VALID / NON-DEGENERATE:", valid_tf_flags[i], "/", nondegen_flags[i])
        print("-" * 80)

    pd.DataFrame({
        "passage": [ex["passage"] for ex in eval_subset],
        "reference_question": ref_questions,
        "reference_answer": ref_answers,
        "teacher_forced_score": tf_scores,
        "teacher_forced_answer": tf_scores > THRESHOLD,
        "generated_raw": raw_outputs,
        "generated_question": pred_questions,
        "generated_answer_beam": gen_answers,
        "generated_answer_score": gen_q_scores,
        "generated_answer_calibrated": scored_answers,
        "format_ok": format_flags,
        "valid_tf_question": valid_tf_flags,
        "non_degenerate": nondegen_flags,
    }).to_csv(f"{OUTPUT_ROOT}/generated_eval.csv", index=False)
    report_df.to_csv(f"{OUTPUT_ROOT}/answer_metrics.csv", index=False)
    print(f"Saved: {OUTPUT_ROOT}/generated_eval.csv, {OUTPUT_ROOT}/answer_metrics.csv")
    print(f"Best model + meta.json in: {BEST_DIR}")

# Load threshold + generation config of the best model (works for both modes)
with open(META_PATH) as f:
    META = json.load(f)
THRESHOLD = float(META.get("threshold", 0.0))
BEST_CFG = META.get("generation_config", {"no_repeat_ngram_size": 3, "repetition_penalty": 1.05})
print("Best model meta:", {k: META[k] for k in ("best_checkpoint", "best_eval_loss", "threshold",
                                                 "generation_config", "device") if k in META})


# =====================================================================
# 15) PASSAGE EXTRACTION: TXT / PDF / DOCX / IMAGE
# =====================================================================
TEXT_EXT = {".txt", ".md", ".csv"}
PDF_EXT = {".pdf"}
DOCX_EXT = {".docx"}
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff", ".webp", ".gif"}
SUPPORTED_EXT = sorted(TEXT_EXT | PDF_EXT | DOCX_EXT | IMAGE_EXT)


def read_txt(path):
    raw = Path(path).read_bytes()
    for enc in ("utf-8-sig", "utf-8", "cp1256", "latin-1"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="ignore")


def ocr_image(img, lang="eng"):
    """OCR a PIL image. Light preprocessing: EXIF rotation, grayscale, upscale small images, autocontrast."""
    import pytesseract
    from PIL import ImageOps
    img = ImageOps.exif_transpose(img).convert("L")
    if min(img.size) < 1000:
        scale = 1000 / min(img.size)
        img = img.resize((int(img.width * scale), int(img.height * scale)))
    img = ImageOps.autocontrast(img)
    return pytesseract.image_to_string(img, lang=lang, config="--psm 3")


def read_image(path, lang="eng"):
    from PIL import Image
    with Image.open(path) as img:
        img.seek(0)  # first frame for GIF/TIFF
        return ocr_image(img.copy(), lang=lang)


def read_pdf(path, lang="eng", ocr_min_chars=30):
    """Text layer via PyMuPDF; pages without text (scanned) fall back to OCR at 300 dpi."""
    import fitz  # pymupdf
    from PIL import Image
    pages = []
    with fitz.open(path) as doc:
        for page in doc:
            text = page.get_text("text")
            if len(text.strip()) < ocr_min_chars:
                pix = page.get_pixmap(dpi=300)
                img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
                text = ocr_image(img, lang=lang)
            pages.append(text)
    return "\n\n".join(pages)


def read_docx(path):
    """Paragraphs + table cells (tables are appended at the end, not in document order)."""
    import docx
    d = docx.Document(path)
    parts = [p.text for p in d.paragraphs]
    for table in d.tables:
        for row in table.rows:
            cells = [c.text.strip() for c in row.cells if c.text.strip()]
            if cells:
                parts.append(" | ".join(dict.fromkeys(cells)))  # merged cells repeat -> dedupe
    return "\n\n".join(parts)


def clean_text(text):
    """Shared normalize_text, then fix hyphenated line breaks and join wrapped lines
    (blank lines stay as paragraph breaks) so uploaded documents look like BoolQ passages."""
    text = normalize_text(text.replace("\x0c", "\n\n"))  # page break -> paragraph break
    text = re.sub(r"(\w)-\n(\w)", r"\1\2", text)
    text = re.sub(r"(?<!\n)\n(?!\n)", " ", text)
    return text


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
    """Pack paragraphs (or sentences of long paragraphs) into passages of <= max_tokens GPT-2 tokens."""
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


# =====================================================================
# 16) SINGLE-PASSAGE INFERENCE (best model + calibrated threshold)
# =====================================================================
@torch.no_grad()
def generate_for_passage(passage, num_candidates=4):
    """Beam search returns several candidates; keep the first valid + non-degenerate one,
    then decide True/False by calibrated scoring (not by the beam's own answer token)."""
    ex = {"passage": passage}
    input_ids, attention_mask, max_len = left_pad([build_prompt_ids(ex)])
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

    score = float(answer_scores([ex], [q], desc="Scoring")[0])
    margin = score - THRESHOLD
    p_true = 1.0 / (1.0 + math.exp(-margin))
    return {
        "question": q,
        "answer": margin > 0,
        "confidence": max(p_true, 1 - p_true),
        "score": score,
        "valid": valid,
        "non_degenerate": nondegen,
    }


# =====================================================================
# 17) GRADIO GUI
# =====================================================================
import gradio as gr


def gui_extract(file_path, ocr_lang):
    if not file_path:
        return "", "Upload a file first (or paste text directly in the box)."
    try:
        text = extract_text(file_path, ocr_lang=ocr_lang)
    except Exception as e:
        return "", f"❌ Extraction failed: {e}"
    if not text.strip():
        return "", "⚠️ No text found (for images/scans check OCR language and image quality)."
    return text, f"✅ Extracted {len(text.split())} words from {Path(file_path).name}"


def gui_generate(text, max_passages, passage_tokens, only_valid, progress=gr.Progress()):
    empty = pd.DataFrame(columns=["#", "Passage", "Question", "Answer", "Confidence", "Score", "Valid"])
    if not text or not text.strip():
        return empty, None, "Nothing to process: extract a file or paste text."
    passages = split_into_passages(clean_text(text), max_tokens=passage_tokens)
    total = len(passages)
    passages = passages[:int(max_passages)]

    rows = []
    for i, p in enumerate(progress.tqdm(passages, desc="Generating")):
        r = generate_for_passage(p)
        if only_valid and not r["non_degenerate"]:
            continue
        rows.append({
            "#": i + 1,
            "Passage": p,
            "Question": r["question"],
            "Answer": "True" if r["answer"] else "False",
            "Confidence": round(r["confidence"], 3),
            "Score": round(r["score"], 3),
            "Valid": r["non_degenerate"],
        })
    df = pd.DataFrame(rows) if rows else empty
    csv_path = f"{OUTPUT_ROOT}/gui_results.csv"
    df.to_csv(csv_path, index=False)
    status = (f"Passages found: {total} | processed: {len(passages)} | questions shown: {len(df)} | "
              f"threshold: {THRESHOLD:+.3f}")
    return df, csv_path, status


_mode = ("GPU · QLoRA 4-bit" if USE_4BIT else "GPU · LoRA") if HAS_CUDA else "CPU · LoRA fp32"
_model_info = (
    f"**Model:** GPT-2 + LoRA (best checkpoint) · {_mode} · `{BEST_DIR}`  \n"
    f"**Best eval loss:** {META.get('best_eval_loss', 'n/a')} · "
    f"**Threshold:** {THRESHOLD:+.3f} · **Generation:** {BEST_CFG}"
)
if "eval_metrics" in META:
    em = META["eval_metrics"]
    _model_info += (f"  \n**Eval (teacher-forced):** balanced acc {em['balanced_acc']:.3f} · "
                    f"macro-F1 {em['macro_f1']:.3f}")

with gr.Blocks(title="True/False Question Generator") as demo:
    gr.Markdown("# 📝 True/False Question Generator\nUpload a TXT / PDF / DOCX / image, "
                "or paste text. Each passage gets one True/False question and its answer.")
    gr.Markdown(_model_info)

    with gr.Row():
        with gr.Column(scale=1):
            file_in = gr.File(label="Upload file", file_types=SUPPORTED_EXT, type="filepath")
            ocr_lang = gr.Dropdown(["eng"], value="eng", label="OCR language (images / scanned PDF)",
                                   info="The model is English-only (GPT-2).")
            extract_btn = gr.Button("1) Extract text", variant="secondary")
            max_passages = gr.Slider(1, 30, value=5, step=1, label="Max passages")
            passage_tokens = gr.Slider(80, min(450, PASSAGE_BUDGET), value=200, step=10,
                                       label="Passage length (tokens)")
            only_valid = gr.Checkbox(value=False, label="Show only valid, non-degenerate questions")
            gen_btn = gr.Button("2) Generate questions", variant="primary")
        with gr.Column(scale=2):
            text_box = gr.Textbox(label="Passage text (editable — you can paste text here directly)",
                                  lines=14, max_lines=30)
            status = gr.Markdown()

    results = gr.Dataframe(label="Results", wrap=True, interactive=False)
    csv_out = gr.File(label="Download results (CSV)")

    extract_btn.click(gui_extract, [file_in, ocr_lang], [text_box, status])
    file_in.upload(gui_extract, [file_in, ocr_lang], [text_box, status])
    gen_btn.click(gui_generate, [text_box, max_passages, passage_tokens, only_valid],
                  [results, csv_out, status])

demo.queue().launch(share=True, debug=False)
