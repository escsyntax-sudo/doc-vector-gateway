from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field


class SearchChunk(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str = Field(min_length=1, max_length=128)
    documentId: str | None = Field(default=None, max_length=128)
    text: str | None = Field(default=None, max_length=20000)
    embedding: list[float] = Field(min_length=1, max_length=8192)


class SearchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    tenantId: str = Field(min_length=1, max_length=64)
    query: str = Field(min_length=1, max_length=2000)
    limit: int = Field(default=10, ge=1, le=50)
    chunks: list[SearchChunk] = Field(default_factory=list, max_length=5000)


class SearchResult(BaseModel):
    id: str
    score: float


class SearchResponse(BaseModel):
    model: str
    dimensions: int
    results: list[SearchResult]


class ChunkResponse(BaseModel):
    seq: int
    text: str
    embedding: list[float]


class ExtractionResponse(BaseModel):
    documentId: str
    filename: str
    text: str
    pageCount: int
    charCount: int
    chunks: list[ChunkResponse]
    embeddingModel: str
    embeddingBackend: str
    dimensions: int
    metadata: dict
