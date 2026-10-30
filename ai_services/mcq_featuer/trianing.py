# """Train the MCQ model with question, options, and authoritative answer labels."""

# from __future__ import annotations

# import gc
# import math
# import sys
# from collections import Counter
# from pathlib import Path


# FEATURE_DIR = Path(__file__).resolve().parent
# REPOSITORY_ROOT = FEATURE_DIR.parents[1]
# if str(REPOSITORY_ROOT) not in sys.path:
#     sys.path.insert(0, str(REPOSITORY_ROOT))

# from ai_services.text_service import normalize_text
# from mcq_contract import InvalidMcqDataError, build_training_target


# DATASET_PATH = FEATURE_DIR / "data" / "final_dataset_mcq.csv"
# OUTPUT_DIR = FEATURE_DIR / "models" / "flan_t5_mcq_train3_60k"
# FINAL_MODEL_DIR = FEATURE_DIR / "model" / "flan_t5_mcq_model3_60k"
# PLOT_PATH = OUTPUT_DIR / "learning_curves_epoch_3epoch.png"
# PREFIX = "Generate a multiple-choice question based on this context: "


# def prepare_training_dataframe(dataframe):
#     """Normalize and validate rows, returning only examples safe for training."""
#     dataframe = dataframe.drop(columns=["Unnamed: 0", "Unnamed: 0.1"], errors="ignore")
#     required = {"context", "question", "answer", "options", "answer_position"}
#     missing = required.difference(dataframe.columns)
#     if missing:
#         raise ValueError(f"Dataset is missing required columns: {', '.join(sorted(missing))}")

#     valid_rows: list[dict[str, str]] = []
#     invalid_reasons: Counter[str] = Counter()
#     for _, row in dataframe.iterrows():
#         context_value = row["context"]
#         context = normalize_text(
#             "" if context_value is None or (isinstance(context_value, float) and math.isnan(context_value)) else str(context_value)
#         )
#         if not context:
#             invalid_reasons["context is empty"] += 1
#             continue
#         try:
#             target = build_training_target(
#                 row["question"], row["options"], row["answer_position"], row["answer"]
#             )
#         except InvalidMcqDataError as error:
#             invalid_reasons[str(error)] += 1
#             continue
#         valid_rows.append({"input": PREFIX + context, "target": target})

#     total = len(dataframe)
#     print(f"Dataset rows: {total}")
#     print(f"Valid rows: {len(valid_rows)}")
#     print(f"Skipped invalid rows: {total - len(valid_rows)}")
#     for reason, count in sorted(invalid_reasons.items()):
#         print(f"  - {reason}: {count}")
#     if not valid_rows:
#         raise ValueError("No valid MCQ training rows remain after validation.")
#     return valid_rows


# def main() -> None:
#     """Load, validate, train, evaluate, and save the MCQ model."""
#     import evaluate
#     import matplotlib.pyplot as plt
#     import numpy as np
#     import pandas as pd
#     from datasets import Dataset
#     from sklearn.model_selection import train_test_split
#     from transformers import (
#         AutoModelForSeq2SeqLM,
#         AutoTokenizer,
#         DataCollatorForSeq2Seq,
#         Seq2SeqTrainer,
#         Seq2SeqTrainingArguments,
#     )

#     dataframe = pd.read_csv(DATASET_PATH)
#     records = prepare_training_dataframe(dataframe)
#     print("\nFormatted target preview:\n")
#     print(records[0]["target"])

#     inputs = np.asarray([record["input"] for record in records])
#     targets = np.asarray([record["target"] for record in records])
#     x_train, _, y_train, _ = train_test_split(inputs, targets, test_size=30, random_state=42)

#     base_model = "google/flan-t5-base"
#     tokenizer = AutoTokenizer.from_pretrained(base_model)
#     model = AutoModelForSeq2SeqLM.from_pretrained(base_model)
#     train_dataset = Dataset.from_dict({"input": x_train.tolist(), "target": y_train.tolist()})

#     def tokenize_fn(batch):
#         model_inputs = tokenizer(batch["input"], max_length=512, truncation=True)
#         labels = tokenizer(batch["target"], max_length=256, truncation=True)
#         model_inputs["labels"] = labels["input_ids"]
#         return model_inputs

#     tokenized_train = train_dataset.map(
#         tokenize_fn, batched=True, remove_columns=["input", "target"]
#     )
#     del dataframe, records, train_dataset
#     gc.collect()

#     bleu_metric = evaluate.load("bleu")

#     def compute_metrics(eval_predictions):
#         predictions, labels = eval_predictions
#         if isinstance(predictions, tuple):
#             predictions = predictions[0]
#         predictions = np.where(predictions != -100, predictions, tokenizer.pad_token_id)
#         labels = np.where(labels != -100, labels, tokenizer.pad_token_id)
#         decoded_predictions = [value.strip() for value in tokenizer.batch_decode(predictions, skip_special_tokens=True)]
#         decoded_labels = [value.strip() for value in tokenizer.batch_decode(labels, skip_special_tokens=True)]
#         bleu = bleu_metric.compute(
#             predictions=decoded_predictions,
#             references=[[label] for label in decoded_labels],
#         )
#         return {
#             "bleu": round(bleu["bleu"] * 100, 2),
#             "gen_len": np.mean([len(tokenizer.encode(value)) for value in decoded_predictions]),
#         }

#     train_count = min(60_000, len(tokenized_train))
#     eval_count = min(2_000, train_count)
#     training_data = tokenized_train.select(range(train_count))
#     evaluation_data = tokenized_train.select(range(eval_count))
#     data_collator = DataCollatorForSeq2Seq(tokenizer=tokenizer, model=model)

#     training_args = Seq2SeqTrainingArguments(
#         output_dir=str(OUTPUT_DIR),
#         learning_rate=1e-4,
#         num_train_epochs=3,
#         save_total_limit=2,
#         per_device_train_batch_size=16,
#         per_device_eval_batch_size=16,
#         gradient_accumulation_steps=2,
#         eval_strategy="steps",
#         eval_steps=500,
#         save_strategy="steps",
#         save_steps=500,
#         logging_steps=500,
#         predict_with_generate=True,
#         generation_max_length=256,
#         eval_accumulation_steps=10,
#         load_best_model_at_end=True,
#         metric_for_best_model="bleu",
#         greater_is_better=True,
#         bf16=False,
#         fp16=False,
#         gradient_checkpointing=True,
#         overwrite_output_dir=True,
#     )
#     trainer = Seq2SeqTrainer(
#         model=model,
#         args=training_args,
#         data_collator=data_collator,
#         train_dataset=training_data,
#         eval_dataset=evaluation_data,
#         processing_class=tokenizer,
#         compute_metrics=compute_metrics,
#     )
#     trainer.train()

#     history = trainer.state.log_history
#     train_loss = [(entry["epoch"], entry["loss"]) for entry in history if "loss" in entry]
#     eval_loss = [(entry["epoch"], entry["eval_loss"]) for entry in history if "eval_loss" in entry]
#     eval_bleu = [(entry["epoch"], entry["eval_bleu"]) for entry in history if "eval_bleu" in entry]
#     figure, axes = plt.subplots(1, 2, figsize=(14, 5))
#     if train_loss:
#         axes[0].plot(*zip(*train_loss), label="Training Loss", color="royalblue")
#     if eval_loss:
#         axes[0].plot(*zip(*eval_loss), label="Validation Loss", color="crimson")
#     axes[0].set_xlabel("epoch")
#     axes[0].set_ylabel("Loss")
#     axes[0].set_title("Training vs Validation Loss")
#     axes[0].legend()
#     axes[0].grid(True, alpha=0.3)
#     if eval_bleu:
#         axes[1].plot(*zip(*eval_bleu), label="Validation BLEU", color="purple")
#         axes[1].legend()
#     axes[1].set_xlabel("epoch")
#     axes[1].set_ylabel("BLEU Score")
#     axes[1].set_title("Validation BLEU Score")
#     axes[1].grid(True, alpha=0.3)
#     figure.tight_layout()
#     OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
#     figure.savefig(PLOT_PATH, dpi=150)
#     plt.close(figure)

#     FINAL_MODEL_DIR.mkdir(parents=True, exist_ok=True)
#     trainer.save_model(str(FINAL_MODEL_DIR))
#     tokenizer.save_pretrained(str(FINAL_MODEL_DIR))
#     print(f"Saved trained model to: {FINAL_MODEL_DIR}")


# if __name__ == "__main__":
#     main()

"""Train the MCQ model with question, options, and authoritative answer labels.
Integrated with Gemini API to validate and correct answers before training.
"""
from __future__ import annotations
import gc
import json
import math
import os
import sys
import time
from collections import Counter
from pathlib import Path

from google import genai
from google.genai import types

FEATURE_DIR = Path(__file__).resolve().parent
REPOSITORY_ROOT = FEATURE_DIR.parents[1]
if str(REPOSITORY_ROOT) not in sys.path:
    sys.path.insert(0, str(REPOSITORY_ROOT))

from ai_services.text_service import normalize_text
from mcq_contract import InvalidMcqDataError, build_training_datset_target # Adjusted to match typical contract names

# ---------------------------------------------------------------------------
# GEMINI API CONFIGURATION
# ---------------------------------------------------------------------------
MODEL_NAME = "gemini-3.1-flash-lite" # Updated to a reliable, fast Gemini model
ENABLE_GEMINI_CORRECTION = True # Set to False to skip API calls and save time/cost

def get_gemini_client():
    """Create a Gemini client using GEMINI_API_KEY from the environment."""
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise ValueError(
            "GEMINI_API_KEY is not set. "
            "Please set it as an environment variable before running."
        )
    return genai.Client(api_key=api_key)


def correct_mcq_with_gemini(question: str, options: str, proposed_answer: str, proposed_position: int) -> dict:
    """
    Uses Gemini to verify if the proposed answer is correct. 
    Returns the validated/corrected answer and its 1-based position.
    """
    if not ENABLE_GEMINI_CORRECTION:
        return {"answer": proposed_answer, "position": proposed_position}

    client = get_gemini_client()
    
    prompt = f"""You are an expert educational content validator. 
Review the following multiple-choice question, its options, and the proposed correct answer.

Question: {question}
Options: {options}
Proposed Correct Answer: {proposed_answer}
Proposed Position: {proposed_position}

Task: Verify if the proposed answer is factually correct and strictly matches one of the provided options. 
- If it is correct, confirm it. 
- If it is incorrect, ambiguous, or doesn't match the options, identify the actual correct option from the list.

Respond ONLY with a valid JSON object in this exact format (no markdown, no extra text):
{{
    "is_valid": true,
    "corrected_answer": "The exact text of the correct option",
    "corrected_position": 1
}}
"""
    try:
        response = client.models.generate_content(
            model=MODEL_NAME,
            contents=prompt,
            config=types.GenerateContentConfig(
                temperature=0.1, # Low temperature for deterministic, factual validation
                response_mime_type="application/json", # Force JSON output
            ),
        )
        
        # Parse the JSON response
        result_text = response.text.strip()
        # Clean up markdown code blocks if Gemini adds them despite the mime type
        if result_text.startswith("```json"):
            result_text = result_text[7:-3].strip()
        elif result_text.startswith("```"):
            result_text = result_text[3:-3].strip()
            
        parsed = json.loads(result_text)
        return {
            "answer": parsed.get("corrected_answer", proposed_answer),
            "position": parsed.get("corrected_position", proposed_position)
        }
        
    except Exception as e:
        print(f"  [WARNING] Gemini validation failed for question: {question[:50]}... Error: {e}")
        # Fallback to original data if API fails
        return {"answer": proposed_answer, "position": proposed_position}


# ---------------------------------------------------------------------------
# DATASET PATHS & CONFIG
# ---------------------------------------------------------------------------
DATASET_PATH = FEATURE_DIR / "data" / "final_dataset_mcq.csv"
OUTPUT_DIR = FEATURE_DIR / "models" / "flan_t5_mcq_train3_60k"
FINAL_MODEL_DIR = FEATURE_DIR / "model" / "flan_t5_mcq_model3_60k"
PLOT_PATH = OUTPUT_DIR / "learning_curves_epoch_3epoch.png"
PREFIX = "Generate a multiple-choice question based on this context: "


def prepare_training_dataframe(dataframe):
    """Normalize, validate, and CORRECT rows using Gemini, returning only safe examples."""
    dataframe = dataframe.drop(columns=["Unnamed: 0", "Unnamed: 0.1"], errors="ignore")
    required = {"context", "question", "answer", "options", "answer_position"}
    missing = required.difference(dataframe.columns)
    if missing:
        raise ValueError(f"Dataset is missing required columns: {', '.join(sorted(missing))}")
    
    valid_rows: list[dict[str, str]] = []
    invalid_reasons: Counter[str] = Counter()
    corrected_count = 0
    
    total = len(dataframe)
    print(f"Total dataset rows: {total}")
    if ENABLE_GEMINI_CORRECTION:
        print("⚠️  Gemini API correction is ENABLED. This may take some time...")

    for idx, row in dataframe.iterrows():
        if ENABLE_GEMINI_CORRECTION and idx % 100 == 0:
            print(f"  Progress: {idx}/{total} rows processed...")
            time.sleep(0.1) # Brief pause to be kind to API rate limits

        context_value = row["context"]
        context = normalize_text(
            "" if context_value is None or (isinstance(context_value, float) and math.isnan(context_value)) else str(context_value)
        )
        if not context:
            invalid_reasons["context is empty"] += 1
            continue
            
        question = str(row["question"]).strip()
        options = str(row["options"]).strip()
        proposed_answer = str(row["answer"]).strip()
        proposed_position = int(row["answer_position"])

        # ✅ GEMINI CORRECTION STEP
        validated = correct_mcq_with_gemini(question, options, proposed_answer, proposed_position)
        
        if validated["answer"] != proposed_answer:
            corrected_count += 1

        try:
            # Build target using the Gemini-verified answer and position
            target = build_training_datset_target(
                question, options, validated["position"], validated["answer"]
            )
        except InvalidMcqDataError as error:
            invalid_reasons[str(error)] += 1
            continue
            
        valid_rows.append({"input": PREFIX + context, "target": target})

    print(f"\n✅ Valid rows: {len(valid_rows)}")
    print(f"❌ Skipped invalid rows: {total - len(valid_rows)}")
    if ENABLE_GEMINI_CORRECTION:
        print(f"🛠️  Answers corrected by Gemini: {corrected_count}")
        
    for reason, count in sorted(invalid_reasons.items()):
        print(f"  - {reason}: {count}")
        
    if not valid_rows:
        raise ValueError("No valid MCQ training rows remain after validation.")
    return valid_rows


def main() -> None:
    """Load, validate, train, evaluate, and save the MCQ model."""
    import evaluate
    import matplotlib.pyplot as plt
    import numpy as np
    import pandas as pd
    from datasets import Dataset
    from sklearn.model_selection import train_test_split
    from transformers import (
        AutoModelForSeq2SeqLM,
        AutoTokenizer,
        DataCollatorForSeq2Seq,
        Seq2SeqTrainer,
        Seq2SeqTrainingArguments,
    )

    print("Loading dataset...")
    dataframe = pd.read_csv(DATASET_PATH)
    
    print("Preparing and validating training data...")
    records = prepare_training_dataframe(dataframe)
    
    print("\nFormatted target preview:\n")
    print(records[0]["target"])
    
    inputs = np.asarray([record["input"] for record in records])
    targets = np.asarray([record["target"] for record in records])
    
    # Note: test_size=30 means 30 samples for eval, rest for training. 
    # Adjust if you meant 0.30 (30%)
    x_train, x_eval, y_train, y_eval = train_test_split(inputs, targets, test_size=0.05, random_state=42)
    
    base_model = "google/flan-t5-base"
    print(f"Loading base model: {base_model}")
    tokenizer = AutoTokenizer.from_pretrained(base_model)
    model = AutoModelForSeq2SeqLM.from_pretrained(base_model)
    
    train_dataset = Dataset.from_dict({"input": x_train.tolist(), "target": y_train.tolist()})
    eval_dataset = Dataset.from_dict({"input": x_eval.tolist(), "target": y_eval.tolist()})

    def tokenize_fn(batch):
        model_inputs = tokenizer(batch["input"], max_length=512, truncation=True)
        labels = tokenizer(batch["target"], max_length=256, truncation=True)
        model_inputs["labels"] = labels["input_ids"]
        return model_inputs

    tokenized_train = train_dataset.map(tokenize_fn, batched=True, remove_columns=["input", "target"])
    tokenized_eval = eval_dataset.map(tokenize_fn, batched=True, remove_columns=["input", "target"])
    
    del dataframe, records, train_dataset, eval_dataset
    gc.collect()
    
    bleu_metric = evaluate.load("bleu")
    
    def compute_metrics(eval_predictions):
        predictions, labels = eval_predictions
        if isinstance(predictions, tuple):
            predictions = predictions[0]
        predictions = np.where(predictions != -100, predictions, tokenizer.pad_token_id)
        labels = np.where(labels != -100, labels, tokenizer.pad_token_id)
        
        decoded_predictions = [value.strip() for value in tokenizer.batch_decode(predictions, skip_special_tokens=True)]
        decoded_labels = [value.strip() for value in tokenizer.batch_decode(labels, skip_special_tokens=True)]
        
        bleu = bleu_metric.compute(
            predictions=decoded_predictions,
            references=[[label] for label in decoded_labels],
        )
        return {
            "bleu": round(bleu["bleu"] * 100, 2),
            "gen_len": np.mean([len(tokenizer.encode(value)) for value in decoded_predictions]),
        }

    # Cap dataset sizes if needed (as in original code)
    train_count = min(60_000, len(tokenized_train))
    eval_count = min(2_000, len(tokenized_eval))
    
    training_data = tokenized_train.select(range(train_count))
    evaluation_data = tokenized_eval.select(range(eval_count))
    
    data_collator = DataCollatorForSeq2Seq(tokenizer=tokenizer, model=model)
    
    training_args = Seq2SeqTrainingArguments(
        output_dir=str(OUTPUT_DIR),
        learning_rate=1e-4,
        num_train_epochs=3,
        save_total_limit=2,
        per_device_train_batch_size=16,
        per_device_eval_batch_size=16,
        gradient_accumulation_steps=2,
        eval_strategy="steps",
        eval_steps=500,
        save_strategy="steps",
        save_steps=500,
        logging_steps=500,
        predict_with_generate=True,
        generation_max_length=256,
        eval_accumulation_steps=10,
        load_best_model_at_end=True,
        metric_for_best_model="bleu",
        greater_is_better=True,
        bf16=False,
        fp16=False,
        gradient_checkpointing=True,
        overwrite_output_dir=True,
    )
    
    trainer = Seq2SeqTrainer(
        model=model,
        args=training_args,
        data_collator=data_collator,
        train_dataset=training_data,
        eval_dataset=evaluation_data,
        processing_class=tokenizer,
        compute_metrics=compute_metrics,
    )
    
    print("\n🚀 Starting training...")
    trainer.train()
    
    print("\n📊 Generating learning curves...")
    history = trainer.state.log_history
    train_loss = [(entry["epoch"], entry["loss"]) for entry in history if "loss" in entry]
    eval_loss = [(entry["epoch"], entry["eval_loss"]) for entry in history if "eval_loss" in entry]
    eval_bleu = [(entry["epoch"], entry["eval_bleu"]) for entry in history if "eval_bleu" in entry]
    
    figure, axes = plt.subplots(1, 2, figsize=(14, 5))
    
    if train_loss:
        axes[0].plot(*zip(*train_loss), label="Training Loss", color="royalblue")
    if eval_loss:
        axes[0].plot(*zip(*eval_loss), label="Validation Loss", color="crimson")
    axes[0].set_xlabel("epoch")
    axes[0].set_ylabel("Loss")
    axes[0].set_title("Training vs Validation Loss")
    axes[0].legend()
    axes[0].grid(True, alpha=0.3)
    
    if eval_bleu:
        axes[1].plot(*zip(*eval_bleu), label="Validation BLEU", color="purple")
        axes[1].legend()
    axes[1].set_xlabel("epoch")
    axes[1].set_ylabel("BLEU Score")
    axes[1].set_title("Validation BLEU Score")
    axes[1].grid(True, alpha=0.3)
    
    figure.tight_layout()
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    figure.savefig(PLOT_PATH, dpi=150)
    plt.close(figure)
    
    FINAL_MODEL_DIR.mkdir(parents=True, exist_ok=True)
    trainer.save_model(str(FINAL_MODEL_DIR))
    tokenizer.save_pretrained(str(FINAL_MODEL_DIR))
    print(f"\n✅ Saved trained model to: {FINAL_MODEL_DIR}")


if __name__ == "__main__":
    main()