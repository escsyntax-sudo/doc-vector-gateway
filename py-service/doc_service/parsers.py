from __future__ import annotations

import csv
import io
import logging
from dataclasses import dataclass, field
from pathlib import Path

from openpyxl import load_workbook
from PyPDF2 import PdfReader

from .chunking import clean_text

logger = logging.getLogger("doc_service.parsers")


class UnsupportedDocument(ValueError):
    pass


class DocumentParseError(ValueError):
    pass


@dataclass
class ParsedDocument:
    text: str
    page_count: int
    metadata: dict = field(default_factory=dict)


def _decode(data: bytes) -> str:
    for encoding in ("utf-8-sig", "cp1252"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    return data.decode("latin-1", errors="replace")


def _parse_pdf_plumber(data: bytes) -> tuple[str, int]:
    import pdfplumber

    with pdfplumber.open(io.BytesIO(data)) as pdf:
        pages = [page.extract_text() or "" for page in pdf.pages]
        return "\n\n".join(pages), len(pages)


def _parse_pdf_pypdf2(data: bytes) -> tuple[str, int]:
    reader = PdfReader(io.BytesIO(data))
    pages = [page.extract_text() or "" for page in reader.pages]
    return "\n\n".join(pages), len(pages)


def parse_pdf(data: bytes) -> ParsedDocument:
    errors: list[str] = []
    try:
        text, pages = _parse_pdf_plumber(data)
        cleaned = clean_text(text)
        if cleaned:
            return ParsedDocument(cleaned, pages, {"parser": "pdfplumber"})
        errors.append("pdfplumber returned no text")
    except Exception as exc:  # noqa: BLE001 - PDF libraries raise varied errors
        errors.append(f"pdfplumber: {exc}")
        logger.info("pdfplumber failed: %s", exc)

    try:
        text, pages = _parse_pdf_pypdf2(data)
        cleaned = clean_text(text)
        if cleaned:
            return ParsedDocument(cleaned, pages, {"parser": "pypdf2"})
        errors.append("PyPDF2 returned no text")
    except Exception as exc:  # noqa: BLE001 - PDF libraries raise varied errors
        errors.append(f"PyPDF2: {exc}")
        logger.info("PyPDF2 failed: %s", exc)

    raise DocumentParseError(
        "No text could be extracted from the PDF. Scanned PDFs need OCR, which is not included. "
        + "; ".join(errors)
    )


def parse_xlsx(data: bytes) -> ParsedDocument:
    try:
        workbook = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    except Exception as exc:
        raise DocumentParseError(f"Could not read the spreadsheet: {exc}") from exc

    lines: list[str] = []
    for sheet in workbook.worksheets:
        lines.append(f"Sheet: {sheet.title}")
        for row in sheet.iter_rows(values_only=True):
            values = [str(value).strip() for value in row if value is not None and str(value).strip()]
            if values:
                lines.append(" | ".join(values))
    page_count = len(workbook.sheetnames)
    workbook.close()
    text = clean_text("\n".join(lines))
    if not text:
        raise DocumentParseError("The spreadsheet contains no readable cell values")
    return ParsedDocument(text, page_count, {"parser": "openpyxl", "sheets": page_count})


def parse_text(data: bytes) -> ParsedDocument:
    text = clean_text(_decode(data))
    if not text:
        raise DocumentParseError("The document contains no text")
    return ParsedDocument(text, 1, {"parser": "text"})


def parse_csv(data: bytes) -> ParsedDocument:
    text = _decode(data)
    try:
        rows = csv.reader(io.StringIO(text))
        lines = [" | ".join(cell.strip() for cell in row) for row in rows if any(cell.strip() for cell in row)]
    except csv.Error as exc:
        raise DocumentParseError(f"Could not read the CSV file: {exc}") from exc
    cleaned = clean_text("\n".join(lines))
    if not cleaned:
        raise DocumentParseError("The CSV file contains no rows")
    return ParsedDocument(cleaned, 1, {"parser": "csv"})


def parse_document(filename: str, data: bytes) -> ParsedDocument:
    suffix = Path(filename).suffix.lower()
    if suffix == ".pdf":
        return parse_pdf(data)
    if suffix == ".xlsx":
        return parse_xlsx(data)
    if suffix == ".csv":
        return parse_csv(data)
    if suffix in {".txt", ".md"}:
        return parse_text(data)
    raise UnsupportedDocument(f"unsupported file extension: {suffix or 'none'}")
