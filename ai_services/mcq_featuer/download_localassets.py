import os
from pathlib import Path

from huggingface_hub import snapshot_download

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "local_assets" / "data"

# مثال: username/mcq-dataset
DATASET_REPO_ID = os.getenv("HF_DATASET_REPO_ID", "PUT_DATASET_REPOSITORY_HERE")


def download_dataset():
    if DATASET_REPO_ID == "PUT_DATASET_REPOSITORY_HERE":
        raise ValueError(
            "Set HF_DATASET_REPO_ID first. Example: username/mcq-dataset"
        )

    DATA_DIR.mkdir(parents=True, exist_ok=True)

    print(f"Downloading dataset: {DATASET_REPO_ID}")
    print(f"Saving to: {DATA_DIR}")

    snapshot_download(
        repo_id=DATASET_REPO_ID,
        repo_type="dataset",
        local_dir=str(DATA_DIR),
    )

    print("Dataset downloaded successfully.")


if __name__ == "__main__":
    download_dataset()