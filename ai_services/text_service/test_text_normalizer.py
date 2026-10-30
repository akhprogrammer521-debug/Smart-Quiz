"""Small dependency-free checks for the shared normalizer."""

from ai_services.text_service import analyze_document_structure, normalize_text


def test_empty_text() -> None:
    assert normalize_text("") == ""


def test_english_spaces_and_blank_lines() -> None:
    assert normalize_text("  Hello\t world!\r\n\r\n\r\n Next   line. ") == "Hello world!\n\nNext line."


def test_arabic_and_unicode_spaces() -> None:
    assert normalize_text("  مرحبا\u00a0\u00a0بالعالم!\u2028\u2028سؤال  مهم؟ ") == "مرحبا بالعالم!\n\nسؤال مهم؟"


def test_controls_and_idempotence() -> None:
    result = normalize_text("One\x00  two\n\n\nThree")
    assert result == "One two\n\nThree"
    assert normalize_text(result) == result


def test_english_headings_pages_and_contents() -> None:
    text = "Table of Contents\nChapter 1 ........ 3\nCells ........ 7\n\n# Chapter 1: Cells\nCells have membranes.\nPage 3"
    result = analyze_document_structure(text, page_boundaries=(0, 52))

    assert result.page_numbers == ("3",)
    assert result.page_boundaries == (0, 52)
    assert result.headings == ("Chapter 1: Cells",)
    assert [(entry.title, entry.page_number) for entry in result.table_of_contents] == [
        ("Chapter 1", "3"), ("Cells", "7")
    ]
    assert normalize_text(result.educational_text) == "# Chapter 1: Cells\nCells have membranes."
    assert "Table of Contents" in text  # The source was not modified.


def test_arabic_headings_and_index() -> None:
    text = "الفهرس\nالفصل الأول ........ ٣\n\nالفصل الأول: الخلية\nتتكون الخلية من غشاء.\nالصفحة ٣"
    result = analyze_document_structure(text)

    assert result.page_numbers == ("٣",)
    assert result.headings == ("الفصل الأول: الخلية",)
    assert [(entry.title, entry.page_number) for entry in result.table_of_contents] == [("الفصل الأول", "٣")]
    assert "الفهرس" not in result.educational_text
    assert "تتكون الخلية من غشاء." in result.educational_text


def test_styled_heading_and_explicit_page_break_without_inventing_numbers() -> None:
    text = "Course Overview\n\nFirst page.\fSecond page."
    result = analyze_document_structure(text, styled_headings=("Course Overview",))

    assert result.headings == ("Course Overview",)
    assert result.page_boundaries == (len("Course Overview\n\nFirst page.\f"),)
    assert result.page_numbers == ()
    assert result.table_of_contents == ()
    assert normalize_text(result.educational_text) == "Course Overview\n\nFirst page.\nSecond page."


def test_plain_content_has_no_invented_structure() -> None:
    result = analyze_document_structure("Cells contain DNA.\nThey divide by mitosis.")
    assert result.page_numbers == ()
    assert result.page_boundaries == ()
    assert result.headings == ()
    assert result.table_of_contents == ()
