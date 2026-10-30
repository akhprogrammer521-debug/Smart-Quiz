"""Focused tests for Gemini grading and its protected Flask endpoint."""

import json
from unittest.mock import MagicMock, patch

import pytest

from grading import grade_short_answer
from summarization_api import app


class TestGradingModel:
    @patch("grading.get_gemini_client")
    def test_returns_valid_structured_result(self, mock_get_client):
        response = MagicMock()
        response.text = json.dumps({
            "isCorrect": False,
            "scoreRatio": 0.5,
            "feedback": "Partially correct.",
            "needsReview": False,
        })
        mock_get_client.return_value.models.generate_content.return_value = response

        result = grade_short_answer("What is ATP?", "Energy", "MEDIUM", "ATP stores energy.")

        assert result["scoreRatio"] == 0.5
        assert result["feedback"] == "Partially correct."

    @patch("grading.get_gemini_client")
    def test_rejects_invalid_model_output(self, mock_get_client):
        response = MagicMock()
        response.text = '{"isCorrect": true, "scoreRatio": 2}'
        mock_get_client.return_value.models.generate_content.return_value = response

        with pytest.raises(RuntimeError, match="invalid response"):
            grade_short_answer("Question", "Answer", "EASY", "Source")

    @patch("grading.get_gemini_client")
    def test_needs_review_is_never_marked_correct(self, mock_get_client):
        response = MagicMock()
        response.text = json.dumps({
            "isCorrect": True,
            "scoreRatio": 0.8,
            "feedback": "The source is ambiguous.",
            "needsReview": True,
        })
        mock_get_client.return_value.models.generate_content.return_value = response

        result = grade_short_answer("Question", "Answer", "HARD", "Ambiguous source")
        assert result["needsReview"] is True
        assert result["isCorrect"] is False


class TestGradingEndpoint:
    def setup_method(self):
        self.client = app.test_client()

    def test_requires_internal_key_configuration(self, monkeypatch):
        monkeypatch.delenv("AI_SERVICE_INTERNAL_KEY", raising=False)
        response = self.client.post("/api/grade-short-answer", json={})
        assert response.status_code == 503

    def test_rejects_unauthorized_request(self, monkeypatch):
        monkeypatch.setenv("AI_SERVICE_INTERNAL_KEY", "server-secret")
        response = self.client.post("/api/grade-short-answer", json={})
        assert response.status_code == 401

    @patch("summarization_api.grade_short_answer")
    def test_returns_strict_grading_json(self, mock_grade, monkeypatch):
        monkeypatch.setenv("AI_SERVICE_INTERNAL_KEY", "server-secret")
        mock_grade.return_value = {
            "isCorrect": True,
            "scoreRatio": 1.0,
            "feedback": "Correct.",
            "needsReview": False,
        }
        response = self.client.post(
            "/api/grade-short-answer",
            headers={"X-Internal-Api-Key": "server-secret"},
            json={
                "question": "What is ATP?",
                "student_answer": "An energy carrier.",
                "difficulty": "medium",
                "source_text": "ATP is the cell's energy carrier.",
            },
        )
        assert response.status_code == 200
        assert response.get_json() == {
            "success": True,
            "isCorrect": True,
            "scoreRatio": 1.0,
            "feedback": "Correct.",
            "needsReview": False,
        }
