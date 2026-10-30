# Text service

`normalize_text(text: str) -> str` prepares extracted educational text for AI
services. It normalizes line endings and whitespace while preserving the words,
punctuation, and paragraph order. It does not extract files or call a model.

Import it with `from ai_services.text_service import normalize_text`. The Flask
services add the project root to Python's import path so this import also works
when each service is started from its own directory.

`analyze_document_structure(text, page_boundaries=(), styled_headings=())`
returns explicit page labels and boundaries, headings, table-of-contents entries,
and a separate `educational_text` copy without page-only or index lines. PDF and
Word extractors can pass page offsets and styled headings when available. The
original extracted text and `normalize_text` behavior remain unchanged; no
missing structure is inferred.
