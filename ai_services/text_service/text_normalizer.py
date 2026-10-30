"""Deterministic whitespace normalization without changing document content."""

import re
from dataclasses import dataclass
from typing import Sequence


@dataclass(frozen=True)
class TableOfContentsEntry:
    """A title and its printed destination page from a document index."""

    title: str
    page_number: str


@dataclass(frozen=True)
class DocumentStructure:
    """Document metadata kept separate from text prepared for a model."""

    page_numbers: tuple[str, ...]
    page_boundaries: tuple[int, ...]
    headings: tuple[str, ...]
    table_of_contents: tuple[TableOfContentsEntry, ...]
    educational_text: str


_PAGE_LINE = re.compile(r"^(?:(?:page|p\.?|صفحة|الصفحة|ص)\s*[:#.-]?\s*)?(\d{1,5})$", re.IGNORECASE)
_LABELED_PAGE = re.compile(r"^(?:page|p\.?|صفحة|الصفحة|ص)\s*[:#.-]?\s*([ivxlcdm]{1,8})$", re.IGNORECASE)
_TOC_TITLE = re.compile(r"^(?:table of contents|contents|index|الفهرس|فهرس المحتويات|المحتويات)\s*[:：]?$", re.IGNORECASE)
_TOC_LEADER = re.compile(r"^(?P<title>.+?)\s*(?:\.{2,}|…+|·{2,})\s*(?P<page>\d{1,5}|[ivxlcdm]{1,8})$", re.IGNORECASE)
_TOC_SPACED = re.compile(r"^(?P<title>.+?)\s{2,}(?P<page>\d{1,5}|[ivxlcdm]{1,8})$", re.IGNORECASE)
_HEADING = re.compile(
    r"^(?:#{1,6}\s+\S|(?:chapter|section|unit|part)\s+\S|"
    r"(?:الفصل|الباب|الوحدة|القسم|المبحث)\s+\S|\d+(?:\.\d+)*[.)]\s+\S)",
    re.IGNORECASE,
)


def normalize_text(text: str) -> str:
    """Normalize line endings, spacing, and blank lines in Arabic or English text.

    Punctuation, letter forms, and the order of content are preserved. At most
    one blank line is kept between paragraphs.
    """
    if not text:
        return ""

    text = re.sub(r"\r\n?|\u0085|\u2028|\u2029", "\n", text)
    text = text.replace("\u200b", " ")
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]", "", text)
    lines = [re.sub(r"[^\S\n]+", " ", line).strip() for line in text.split("\n")]
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


def analyze_document_structure(
    text: str,
    *,
    page_boundaries: Sequence[int] = (),
    styled_headings: Sequence[str] = (),
) -> DocumentStructure:
    """Find explicit pages, headings, and index entries without changing source text.

    ``page_boundaries`` are zero-based offsets supplied by an extractor (for
    example, PDF page starts). ``styled_headings`` are titles identified from
    document styles. Only clear printed page labels and index entries are
    removed from ``educational_text``; the original input remains untouched.
    """
    if not text:
        return DocumentStructure((), (), (), (), "")

    lines = text.replace("\r\n", "\n").replace("\r", "\n").replace("\f", "\n").split("\n")
    boundaries = {offset for offset in page_boundaries if 0 <= offset < len(text)}
    boundaries.update(match.end() for match in re.finditer("\f", text))
    page_numbers: list[str] = []
    toc: list[TableOfContentsEntry] = []
    omitted: set[int] = set()
    toc_title_line: int | None = None

    for index, line in enumerate(lines):
        stripped = line.strip()
        if _TOC_TITLE.fullmatch(stripped):
            toc_title_line = index
            continue

        entry = _TOC_LEADER.fullmatch(stripped)
        if entry is None and toc_title_line is not None:
            entry = _TOC_SPACED.fullmatch(line)
        if entry is not None:
            toc.append(TableOfContentsEntry(entry.group("title").strip(), entry.group("page")))
            omitted.add(index)
            if toc_title_line is not None:
                omitted.add(toc_title_line)
            continue

        if toc_title_line is not None and stripped:
            toc_title_line = None

        page = _PAGE_LINE.fullmatch(stripped) or _LABELED_PAGE.fullmatch(stripped)
        if page is not None:
            page_numbers.append(page.group(1))
            omitted.add(index)

    headings: list[str] = []
    styled = {heading.strip() for heading in styled_headings if heading.strip()}
    first_content_line = next((index for index, line in enumerate(lines) if line.strip() and index not in omitted), None)
    for index, line in enumerate(lines):
        title = line.strip()
        if index in omitted or not 3 <= len(title) <= 120:
            continue
        is_first_title = (
            index == first_content_line
            and index + 1 < len(lines)
            and not lines[index + 1].strip()
            and not title.endswith((".", "!", "?", "؟"))
        )
        if title in styled or _HEADING.match(title) or is_first_title:
            title = re.sub(r"^#{1,6}\s+", "", title)
            if title not in headings:
                headings.append(title)

    educational_text = "\n".join(line for index, line in enumerate(lines) if index not in omitted)
    return DocumentStructure(
        tuple(page_numbers),
        tuple(sorted(boundaries)),
        tuple(headings),
        tuple(toc),
        educational_text,
    )
