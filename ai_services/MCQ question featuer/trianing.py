import os
from pathlib import Path

SERVICE_DIR = Path(__file__).resolve().parent
TRAINING_DIR = Path(os.getenv("MCQ_TRAINING_DIR", str(SERVICE_DIR / "training_output")))
TRAINING_DIR.mkdir(parents=True, exist_ok=True)

import pandas as pd
df = pd.read_csv('data/final_dataset_mcq')


print(df.shape)
print(df.isna().sum())


df.drop(columns=['Unnamed: 0.1','Unnamed: 0'],inplace=True)


prefix = "Generate a multiple-choice question based on this context: "

df["input"] = prefix + df["context"]



import pandas as pd, ast
from string import ascii_uppercase

def make_target(row):
    opts = row["options"]
    if isinstance(opts, str):
        opts = ast.literal_eval(opts)
    lines = [f"{ascii_uppercase[i]}) {o}" for i, o in enumerate(opts)]
    return (f"QUESTION: {row['question']}\nOPTIONS:\n"
            + "\n".join(lines))

df["target"] = df.apply(make_target, axis=1)
df[["target"]].to_csv("target.csv", index=False)


sample = df.sample(10)

for i, row in sample.iterrows():
    print("=" * 100)
    print(f"INDEX: {i}")

    print("\ninput:")
    print(row["input"])

    print("\ntarget:")
    print(row["target"])



x = df['input']
y = df['target']

x = x.to_numpy()
y = y.to_numpy()

from sklearn.model_selection import train_test_split


x_train , x_temp ,y_train ,y_temp = train_test_split(x, y, test_size=30, random_state=42)

x_val , x_test , y_val , y_test = train_test_split(x_temp, y_temp, test_size=0.5, random_state=42)


import torch 
import torch.nn as nn 
from transformers import AutoTokenizer,AutoModelForSeq2SeqLM ,DataCollatorForSeq2Seq,Seq2SeqTrainingArguments,Seq2SeqTrainer

FLAN_T5_BASE = "google/flan-t5-base"

flan_t5_tokenizer = AutoTokenizer.from_pretrained(FLAN_T5_BASE)
flan_t5_model = AutoModelForSeq2SeqLM.from_pretrained(FLAN_T5_BASE)


x_train = x_train.tolist()
y_trian = y_train.tolist()

print(type(x_train))
print(type(y_train))


import gc
from datasets import Dataset

# 1) امسح المتغيرات الكبيرة اللي مش محتاجها بعد كده
del df
gc.collect()

# 2) حوّل بياناتك لـ Dataset بدل list عادية
train_ds = Dataset.from_dict({"input": x_train, "target": y_trian})

# 3) دالة التوكنايز هتشتغل على batches صغيرة مش كل الداتا مرة واحدة
def tokenize_fn(batch):
    model_inputs = flan_t5_tokenizer(
        batch["input"], max_length=512, truncation=True
    )
    labels = flan_t5_tokenizer(
        batch["target"], max_length=128, truncation=True
    )
    model_inputs["labels"] = labels["input_ids"]
    return model_inputs

# batched=True بيبعت الداتا على دفعات (افتراضيًا 1000 صف كل مرة)
tokenized_train_mcq = train_ds.map(
    tokenize_fn,
    batched=True,
    remove_columns=["input", "target"],
)

print(tokenized_train_mcq)
print(tokenized_train_mcq[0].keys())





# 2) حوّل بياناتك لـ Dataset بدل list عادية
val_ds = Dataset.from_dict({"input": x_val, "target": y_val})

# 3) دالة التوكنايز هتشتغل على batches صغيرة مش كل الداتا مرة واحدة
def tokenize_fn(batch):
    model_inputs = flan_t5_tokenizer(
        batch["input"], max_length=512, truncation=True
    )
    labels = flan_t5_tokenizer(
        batch["target"], max_length=128, truncation=True
    )
    model_inputs["labels"] = labels["input_ids"]
    return model_inputs

# batched=True بيبعت الداتا على دفعات (افتراضيًا 1000 صف كل مرة)
tokenized_val_mcq = val_ds.map(
    tokenize_fn,
    batched=True,
    remove_columns=["input", "target"],
)

print(tokenized_val_mcq)
print(tokenized_val_mcq[0].keys())




# 2) حوّل بياناتك لـ Dataset بدل list عادية
test_ds = Dataset.from_dict({"input": x_test, "target": y_test})

# 3) دالة التوكنايز هتشتغل على batches صغيرة مش كل الداتا مرة واحدة
def tokenize_fn(batch):
    model_inputs = flan_t5_tokenizer(
        batch["input"], max_length=512, truncation=True
    )
    labels = flan_t5_tokenizer(
        batch["target"], max_length=128, truncation=True
    )
    model_inputs["labels"] = labels["input_ids"]
    return model_inputs

# batched=True بيبعت الداتا على دفعات (افتراضيًا 1000 صف كل مرة)
tokenized_test_mcq = test_ds.map(
    tokenize_fn,
    batched=True,
    remove_columns=["input", "target"],
)

print(tokenized_test_mcq)
print(tokenized_test_mcq[0].keys())



print(tokenized_train_mcq['input_ids'][0][50])
print(tokenized_train_mcq['attention_mask'][0])
print(tokenized_train_mcq['labels'][0])

print(tokenized_val_mcq['input_ids'][0][50])
print(tokenized_val_mcq['attention_mask'][0])
print(tokenized_val_mcq['labels'][0])

print(tokenized_test_mcq['input_ids'][0][50])
print(tokenized_test_mcq['attention_mask'][0])
print(tokenized_test_mcq['labels'][0])


import numpy as np
import evaluate

bleu_metric = evaluate.load("bleu")

def compute_metrics(eval_preds):
    preds, labels = eval_preds
    if isinstance(preds, tuple):
        preds = preds[0]

    preds = np.where(preds != -100, preds, flan_t5_tokenizer.pad_token_id)
    decoded_preds = flan_t5_tokenizer.batch_decode(preds, skip_special_tokens=True)

    labels = np.where(labels != -100, labels, flan_t5_tokenizer.pad_token_id)
    decoded_labels = flan_t5_tokenizer.batch_decode(labels, skip_special_tokens=True)

    decoded_preds = [p.strip() for p in decoded_preds]
    decoded_labels = [l.strip() for l in decoded_labels]

    bleu_result = bleu_metric.compute(
        predictions=decoded_preds,
        references=[[l] for l in decoded_labels],
    )

    result = {"bleu": round(bleu_result["bleu"] * 100, 2)}
    result["gen_len"] = np.mean([len(flan_t5_tokenizer.encode(p)) for p in decoded_preds])

    return result


small_dataset_train1 = tokenized_train_mcq.select(range(40000))
small_dataset_val1 = tokenized_train_mcq.select(range(4000))


flan_t5_data_collator = DataCollatorForSeq2Seq(tokenizer=flan_t5_tokenizer, model=flan_t5_model)

flan_t5_arg = Seq2SeqTrainingArguments(
    output_dir=str(TRAINING_DIR),
    per_device_train_batch_size=8,
    per_device_eval_batch_size=4,          # أقل
    gradient_accumulation_steps=2,         # لتعويض الـ batch
    num_train_epochs=2,
    learning_rate=5e-5,
    eval_strategy="steps",
    eval_steps=500,                        # مو 50
    save_strategy="steps",
    save_steps=500,                        # لازم يكون من مضاعفات eval_steps
    logging_steps=20,
    predict_with_generate=True,
    generation_max_length=256,             # الأفضل: حسب أطول جواب عندك فعلياً
    eval_accumulation_steps=10,            # ينقل النتائج للـ CPU تدريجياً
    load_best_model_at_end=True,
    metric_for_best_model="bleu",
    greater_is_better=True,
    bf16=False, fp16=False,                # T4 ما بيدعم bf16، وT5 مع fp16 بيعطي NaN
    gradient_checkpointing=True,           # بيوفر ذاكرة بالتدريب
)

flan_t5_trainer = Seq2SeqTrainer(
    model=flan_t5_model,
    args=flan_t5_arg,
    data_collator=flan_t5_data_collator,
    train_dataset=small_dataset_train1,
    eval_dataset=small_dataset_val1,
    processing_class=flan_t5_tokenizer,
    compute_metrics=compute_metrics,
)

flan_t5_trainer.train(resume_from_checkpoint=True)


import matplotlib.pyplot as plt

history = flan_t5_trainer.state.log_history

# استخراج البيانات من الـ log history
train_loss = [(x["step"], x["loss"]) for x in history if "loss" in x]
eval_loss = [(x["step"], x["eval_loss"]) for x in history if "eval_loss" in x]
eval_bleu = [(x["step"], x["eval_bleu"]) for x in history if "eval_bleu" in x]

fig, axes = plt.subplots(1, 2, figsize=(14, 5))

# الرسم الأول: Training Loss vs Validation Loss
axes[0].plot(*zip(*train_loss), label="Training Loss", color="royalblue")
if eval_loss:
    axes[0].plot(*zip(*eval_loss), label="Validation Loss", color="crimson")
axes[0].set_xlabel("Step")
axes[0].set_ylabel("Loss")
axes[0].set_title("Training vs Validation Loss")
axes[0].legend()
axes[0].grid(True, alpha=0.3)

# الرسم الثاني: Validation BLEU
if eval_bleu:
    axes[1].plot(*zip(*eval_bleu), label="Validation BLEU", color="purple")
axes[1].set_xlabel("Step")
axes[1].set_ylabel("BLEU Score")
axes[1].set_title("Validation BLEU Score")
axes[1].legend()
axes[1].grid(True, alpha=0.3)

plt.tight_layout()
plt.savefig(TRAINING_DIR / "learning_curves.png", dpi=150)
plt.show()


from transformers import AutoTokenizer, AutoModelForSeq2SeqLM

model_path = os.getenv("MODEL_PATH", str(SERVICE_DIR / "model" / "flan_t5_mcq_final"))

tokenizer = AutoTokenizer.from_pretrained(model_path)
model = AutoModelForSeq2SeqLM.from_pretrained(model_path)
