from __future__ import annotations

import os
from dataclasses import dataclass

DEFAULT_TOKEN = "dev-internal-token"


def _int(name: str, fallback: int) -> int:
    try:
        return int(os.environ.get(name, fallback))
    except (TypeError, ValueError):
        return fallback


def _float(name: str, fallback: float) -> float:
    try:
        return float(os.environ.get(name, fallback))
    except (TypeError, ValueError):
        return fallback


@dataclass(frozen=True)
class Settings:
    environment: str = "development"
    internal_token: str = DEFAULT_TOKEN
    max_upload_bytes: int = 20 * 1024 * 1024
    max_chunks_per_document: int = 2000
    max_search_chunks: int = 5000
    chunk_size: int = 1200
    chunk_overlap: int = 200
    embedding_backend: str = "auto"
    embedding_model: str = "sentence-transformers/all-MiniLM-L6-v2"
    embedding_batch_size: int = 32
    hash_dimensions: int = 384

    def validated(self) -> Settings:
        if self.chunk_size < 100:
            raise ValueError("DOC_CHUNK_SIZE must be at least 100")
        if self.chunk_overlap < 0 or self.chunk_overlap >= self.chunk_size:
            raise ValueError("DOC_CHUNK_OVERLAP must be smaller than DOC_CHUNK_SIZE")
        if self.embedding_backend not in {"auto", "hash", "sentence-transformers"}:
            raise ValueError("DOC_EMBEDDING_BACKEND must be auto, hash or sentence-transformers")
        if self.environment == "production" and self.internal_token == DEFAULT_TOKEN:
            raise ValueError("DOC_INTERNAL_TOKEN must be changed in production")
        if len(self.internal_token) < 12:
            raise ValueError("DOC_INTERNAL_TOKEN must be at least 12 characters")
        return self


def load_settings() -> Settings:
    settings = Settings(
        environment=os.environ.get("DOC_ENV", "development"),
        internal_token=os.environ.get("DOC_INTERNAL_TOKEN", DEFAULT_TOKEN),
        max_upload_bytes=_int("DOC_MAX_UPLOAD_BYTES", 20 * 1024 * 1024),
        max_chunks_per_document=_int("DOC_MAX_CHUNKS", 2000),
        max_search_chunks=_int("DOC_MAX_SEARCH_CHUNKS", 5000),
        chunk_size=_int("DOC_CHUNK_SIZE", 1200),
        chunk_overlap=_int("DOC_CHUNK_OVERLAP", 200),
        embedding_backend=os.environ.get("DOC_EMBEDDING_BACKEND", "auto"),
        embedding_model=os.environ.get(
            "DOC_EMBEDDING_MODEL", "sentence-transformers/all-MiniLM-L6-v2"
        ),
        embedding_batch_size=_int("DOC_EMBEDDING_BATCH", 32),
        hash_dimensions=_int("DOC_HASH_DIMENSIONS", 384),
    )
    return settings.validated()
