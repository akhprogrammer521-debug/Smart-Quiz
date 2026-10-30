"""Shared text preparation for the AI services."""

from .text_normalizer import (
    DocumentStructure,
    TableOfContentsEntry,
    analyze_document_structure,
    normalize_text,
)

__all__ = ["DocumentStructure", "TableOfContentsEntry", "analyze_document_structure", "normalize_text"]
