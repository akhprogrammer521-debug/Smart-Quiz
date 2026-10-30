"""Pure formatting and parsing helpers for the MCQ training and API contract."""

from __future__ import annotations

import ast
import math
import re
from typing import Any


OPTION_LABELS = ("A", "B", "C", "D")


class InvalidMcqDataError(ValueError):
    """Raised when a dataset row or generated MCQ violates the required format."""


def _normalized_value(value: Any) -> str:
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return ""
    return " ".join(str(value).split()).casefold()


def parse_dataset_options(value: Any) -> list[str]:
    """Safely parse a dataset options value into exactly four non-empty strings."""
    try:
        options = ast.literal_eval(value) if isinstance(value, str) else value
    except (SyntaxError, ValueError) as error:
        raise InvalidMcqDataError("options could not be parsed") from error
    if not isinstance(options, (list, tuple)) or len(options) != 4:
        raise InvalidMcqDataError("options must contain exactly four values")
    cleaned = [" ".join(str(option).split()) for option in options]
    if any(not option for option in cleaned):
        raise InvalidMcqDataError("options must not be empty")
    return cleaned


def build_training_target(
    question: Any,
    options_value: Any,
    answer_position: Any,
    answer_text: Any,
) -> str:
    """Validate one dataset row and return the exact model target string."""
    clean_question = " ".join(str(question).split()) if _normalized_value(question) else ""
    if not clean_question:
        raise InvalidMcqDataError("question is empty")

    options = parse_dataset_options(options_value)
    label = str(answer_position).strip().upper() if _normalized_value(answer_position) else ""
    if label not in OPTION_LABELS:
        raise InvalidMcqDataError("answer_position must be A, B, C, or D")

    normalized_answer = _normalized_value(answer_text)
    selected_option = options[OPTION_LABELS.index(label)]
    if normalized_answer and _normalized_value(selected_option) != normalized_answer:
        raise InvalidMcqDataError("answer text does not match answer_position")

    option_lines = "\n".join(
        f"{option_label}) {option}"
        for option_label, option in zip(OPTION_LABELS, options, strict=True)
    )
    return f"QUESTION: {clean_question}\nOPTIONS:\n{option_lines}\nANSWER: {label}"


def parse_mcq_output(text: str) -> dict[str, object]:
    """Parse a complete generated MCQ without guessing missing fields."""
    match = re.fullmatch(
        r"\s*QUESTION:\s*(.*?)\s+OPTIONS:\s*(.*?)\s+ANSWER:\s*([A-Za-z])\s*",
        text,
        flags=re.DOTALL | re.IGNORECASE,
    )
    if match is None:
        raise InvalidMcqDataError("generated output is missing QUESTION, OPTIONS, or ANSWER")

    question = " ".join(match.group(1).split())
    answer = match.group(3).upper()
    if not question or answer not in OPTION_LABELS:
        raise InvalidMcqDataError("generated question or answer is invalid")

    parts = re.split(r"(?:^|\s)([A-Da-d])\)\s*", match.group(2))
    options = [
        {"label": parts[index].upper(), "text": " ".join(parts[index + 1].split())}
        for index in range(1, len(parts) - 1, 2)
    ]
    labels = [option["label"] for option in options]
    if labels != list(OPTION_LABELS) or any(not option["text"] for option in options):
        raise InvalidMcqDataError("generated output must contain non-empty A-D options")
    if answer not in labels:
        raise InvalidMcqDataError("generated answer label is not present in options")

    return {"question": question, "options": options, "correctAnswer": answer}
