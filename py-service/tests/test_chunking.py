from __future__ import annotations

import pytest

from doc_service.chunking import chunk_text, clean_text, cosine_similarity


def test_chunks_respect_size_and_cover_the_document() -> None:
    text = " ".join(f"word{index}" for index in range(600))
    chunks = chunk_text(text, size=300, overlap=50)
    assert len(chunks) > 1
    assert all(len(chunk) <= 300 for chunk in chunks)
    assert chunks[0].startswith("word0")
    assert chunks[-1].endswith("word599")


def test_chunk_overlap_shares_text() -> None:
    text = " ".join(f"token{index}" for index in range(300))
    chunks = chunk_text(text, size=200, overlap=40)
    assert len(chunks) > 1
    tail = chunks[0][-40:]
    assert any(token in chunks[1] for token in tail.split())
    assert len(set(chunks)) == len(chunks)


def test_rejects_invalid_chunk_settings() -> None:
    with pytest.raises(ValueError):
        chunk_text("text", size=50)
    with pytest.raises(ValueError):
        chunk_text("text", size=100, overlap=100)


def test_clean_text_normalizes_whitespace() -> None:
    assert clean_text(" alpha\r\n\r\n\r\nbeta \n") == "alpha\n\nbeta"


def test_cosine_similarity_handles_edge_cases() -> None:
    assert cosine_similarity([1.0, 0.0], [1.0, 0.0]) == pytest.approx(1.0)
    assert cosine_similarity([1.0, 0.0], [0.0, 1.0]) == pytest.approx(0.0)
    assert cosine_similarity([], []) == 0.0
    assert cosine_similarity([1.0], [1.0, 2.0]) == 0.0
