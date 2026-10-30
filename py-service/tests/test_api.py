from __future__ import annotations

import io

import pytest
from fastapi.testclient import TestClient
from openpyxl import Workbook

from doc_service.config import Settings
from doc_service.embeddings import HashingEmbedder
from doc_service.main import create_app

TOKEN = "test-internal-token"
HEADERS = {"x-internal-token": TOKEN}


def make_pdf(text: str) -> bytes:
    stream = f"BT /F1 12 Tf 72 720 Td ({text}) Tj ET".encode("latin-1")
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        (b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
         b"/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>"),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
    ]
    payload = bytearray(b"%PDF-1.4\n")
    offsets = []
    for index, body in enumerate(objects, start=1):
        offsets.append(len(payload))
        payload.extend(f"{index} 0 obj\n".encode())
        payload.extend(body)
        payload.extend(b"\nendobj\n")
    xref_start = len(payload)
    payload.extend(f"xref\n0 {len(objects) + 1}\n".encode())
    payload.extend(b"0000000000 65535 f \n")
    for offset in offsets:
        payload.extend(f"{offset:010d} 00000 n \n".encode())
    payload.extend(
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref_start}\n%%EOF\n".encode()
    )
    return bytes(payload)


@pytest.fixture()
def client() -> TestClient:
    settings = Settings(
        internal_token=TOKEN,
        embedding_backend="hash",
        hash_dimensions=64,
        chunk_size=200,
        chunk_overlap=40,
    )
    with TestClient(create_app(settings)) as test_client:
        yield test_client


def test_health_requires_token_and_reports_embedding(client: TestClient) -> None:
    assert client.get("/health").status_code == 401
    response = client.get("/health", headers=HEADERS)
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["embedding"]["backend"] == "hash"
    assert body["embedding"]["dimensions"] == 64


def test_extracts_and_chunks_plain_text(client: TestClient) -> None:
    text = ("Alpha revenue grew across the segment. " * 8).encode()
    response = client.post(
        "/extract",
        headers=HEADERS,
        data={"tenant_id": "alpha", "document_id": "doc-1"},
        files={"file": ("note.txt", text, "text/plain")},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["documentId"] == "doc-1"
    assert body["pageCount"] == 1
    assert body["embeddingModel"] == "hash-64"
    assert len(body["chunks"]) > 1
    assert all(len(chunk["embedding"]) == 64 for chunk in body["chunks"])
    assert all(len(chunk["text"]) <= 200 for chunk in body["chunks"])


def test_extracts_xlsx_rows(client: TestClient) -> None:
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "Revenue"
    sheet.append(["Account", "Amount"])
    sheet.append(["Alpha", 1200])
    buffer = io.BytesIO()
    workbook.save(buffer)

    response = client.post(
        "/extract",
        headers=HEADERS,
        data={"tenant_id": "alpha", "document_id": "sheet-1"},
        files={
            "file": (
                "revenue.xlsx",
                buffer.getvalue(),
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            )
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["pageCount"] == 1
    assert "Alpha | 1200" in body["text"]
    assert body["metadata"]["parser"] == "openpyxl"


def test_extracts_pdf_text(client: TestClient) -> None:
    response = client.post(
        "/extract",
        headers=HEADERS,
        data={"tenant_id": "alpha", "document_id": "pdf-1"},
        files={"file": ("report.pdf", make_pdf("Alpha revenue report"), "application/pdf")},
    )
    assert response.status_code == 200
    body = response.json()
    assert "Alpha revenue report" in body["text"]
    assert body["metadata"]["parser"] in {"pdfplumber", "pypdf2"}


def test_rejects_bad_types_and_unauthorized_calls(client: TestClient) -> None:
    unauthorized = client.post(
        "/extract",
        data={"tenant_id": "alpha", "document_id": "doc-1"},
        files={"file": ("note.txt", b"hello", "text/plain")},
    )
    assert unauthorized.status_code == 401

    unsupported = client.post(
        "/extract",
        headers=HEADERS,
        data={"tenant_id": "alpha", "document_id": "doc-1"},
        files={"file": ("payload.exe", b"hello", "application/octet-stream")},
    )
    assert unsupported.status_code == 415
    assert unsupported.json()["detail"]["code"] == "unsupported_file_type"


def test_search_ranks_candidate_chunks(client: TestClient) -> None:
    extracted = client.post(
        "/extract",
        headers=HEADERS,
        data={"tenant_id": "alpha", "document_id": "doc-1"},
        files={
            "file": (
                "note.txt",
                b"Budget planning covers travel and software. " * 12,
                "text/plain",
            )
        },
    )
    assert extracted.status_code == 200
    chunks = extracted.json()["chunks"]
    payload = {
        "tenantId": "alpha",
        "query": "budget planning",
        "limit": 3,
        "chunks": [
            {"id": f"chunk-{index}", "text": chunk["text"], "embedding": chunk["embedding"]}
            for index, chunk in enumerate(chunks)
        ],
    }
    response = client.post("/search", headers=HEADERS, json=payload)
    assert response.status_code == 200
    body = response.json()
    assert body["model"] == "hash-64"
    assert len(body["results"]) == min(3, len(chunks))
    scores = [item["score"] for item in body["results"]]
    assert scores == sorted(scores, reverse=True)


def test_enforces_upload_limit() -> None:
    settings = Settings(
        internal_token=TOKEN,
        embedding_backend="hash",
        hash_dimensions=64,
        max_upload_bytes=1024,
    )
    with TestClient(create_app(settings)) as small_client:
        response = small_client.post(
            "/extract",
            headers=HEADERS,
            data={"tenant_id": "alpha", "document_id": "doc-1"},
            files={"file": ("big.txt", b"a" * 2048, "text/plain")},
        )
    assert response.status_code == 413
    assert response.json()["detail"]["code"] == "file_too_large"


def test_hash_embedder_is_deterministic_and_normalized() -> None:
    embedder = HashingEmbedder(64)
    first = embedder.embed(["alpha revenue report"])[0]
    second = embedder.embed(["alpha revenue report"])[0]
    other = embedder.embed(["unrelated weather notes"])[0]
    assert first == second
    assert len(first) == 64
    assert abs(sum(value * value for value in first) ** 0.5 - 1.0) < 1e-9
    assert sum(a * b for a, b in zip(first, second)) > sum(a * b for a, b in zip(first, other))
