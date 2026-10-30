"""Focused tests for the MCQ dataset and model-output contract."""

import sys
from pathlib import Path

import pytest


FEATURE_DIR = Path(__file__).resolve().parent
if str(FEATURE_DIR) not in sys.path:
    sys.path.insert(0, str(FEATURE_DIR))

from mcq_contract import InvalidMcqDataError, build_training_target, parse_mcq_output


def test_training_target_contains_authoritative_answer() -> None:
    target = build_training_target(
        "Which organelle produces energy?",
        "['Nucleus', 'Mitochondrion', 'Ribosome', 'Golgi body']",
        "B",
        "  mitochondrion ",
    )
    assert target == (
        "QUESTION: Which organelle produces energy?\n"
        "OPTIONS:\n"
        "A) Nucleus\n"
        "B) Mitochondrion\n"
        "C) Ribosome\n"
        "D) Golgi body\n"
        "ANSWER: B"
    )


def test_training_target_rejects_mismatched_or_unsafe_data() -> None:
    with pytest.raises(InvalidMcqDataError):
        build_training_target("Question?", "['A', 'B', 'C', 'D']", "A", "B")
    with pytest.raises(InvalidMcqDataError):
        build_training_target("Question?", "__import__('os').system('echo unsafe')", "A", "A")


def test_parse_mcq_returns_valid_correct_answer_label() -> None:
    parsed = parse_mcq_output(
        "QUESTION: Which organelle produces energy?\n"
        "OPTIONS:\nA) Nucleus\nB) Mitochondrion\nC) Ribosome\nD) Golgi body\n"
        "ANSWER: B"
    )
    assert parsed["correctAnswer"] == "B"
    assert [option["label"] for option in parsed["options"]] == ["A", "B", "C", "D"]


@pytest.mark.parametrize(
    "output",
    [
        "QUESTION: Missing answer? OPTIONS: A) One B) Two C) Three D) Four",
        "QUESTION: Invalid answer? OPTIONS: A) One B) Two C) Three D) Four ANSWER: E",
        "QUESTION: Missing option? OPTIONS: A) One B) Two C) Three ANSWER: A",
    ],
)
def test_parse_mcq_rejects_missing_or_invalid_answers(output: str) -> None:
    with pytest.raises(InvalidMcqDataError):
        parse_mcq_output(output)
