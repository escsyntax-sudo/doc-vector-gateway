from __future__ import annotations

import hmac
import logging
import re
from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from . import __version__
from .chunking import chunk_text, cosine_similarity
from .config import Settings, load_settings
from .embeddings import create_embedder
from .models import (
    ChunkResponse,
    ExtractionResponse,
    SearchRequest,
    SearchResponse,
    SearchResult,
)
from .parsers import DocumentParseError, UnsupportedDocument, parse_document

logger = logging.getLogger("doc_service")
TENANT_PATTERN = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$")


def _fail(status: int, message: str, code: str) -> None:
    raise HTTPException(status_code=status, detail={"message": message, "code": code})


def create_app(settings: Settings | None = None) -> FastAPI:
    resolved = (settings or load_settings()).validated()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.embedder = create_embedder(resolved)
        logger.info(
            "embedding backend ready: %s (%s, %d dimensions)",
            app.state.embedder.backend,
            app.state.embedder.model_name,
            app.state.embedder.dimensions,
        )
        yield

    app = FastAPI(
        title="DOC extractor service",
        version=__version__,
        lifespan=lifespan,
        docs_url="/docs",
        redoc_url=None,
    )
    app.state.settings = resolved

    async def require_token(
        request: Request,
        x_internal_token: Annotated[str | None, Header(alias="x-internal-token")] = None,
    ) -> None:
        if not x_internal_token or not hmac.compare_digest(
            x_internal_token, request.app.state.settings.internal_token
        ):
            _fail(401, "invalid internal token", "unauthorized")

    @app.get("/health", dependencies=[Depends(require_token)])
    async def health(request: Request) -> dict:
        embedder = request.app.state.embedder
        return {
            "status": "ok",
            "version": __version__,
            "embedding": {
                "backend": embedder.backend,
                "model": embedder.model_name,
                "dimensions": embedder.dimensions,
            },
            "limits": {
                "maxUploadBytes": resolved.max_upload_bytes,
                "maxChunks": resolved.max_chunks_per_document,
                "chunkSize": resolved.chunk_size,
                "chunkOverlap": resolved.chunk_overlap,
            },
            "parsers": ["pdf", "xlsx", "csv", "txt", "md"],
        }

    @app.post(
        "/extract",
        response_model=ExtractionResponse,
        dependencies=[Depends(require_token)],
    )
    async def extract(
        request: Request,
        file: Annotated[UploadFile, File()],
        tenant_id: Annotated[str, Form()],
        document_id: Annotated[str, Form()],
    ) -> ExtractionResponse:
        if not TENANT_PATTERN.fullmatch(tenant_id):
            _fail(422, "tenant_id is invalid", "invalid_tenant")
        if not document_id or len(document_id) > 128:
            _fail(422, "document_id is invalid", "invalid_document")
        if not file.filename:
            _fail(422, "a filename is required", "filename_required")

        data = await file.read(resolved.max_upload_bytes + 1)
        if len(data) > resolved.max_upload_bytes:
            _fail(413, "file exceeds the extraction size limit", "file_too_large")
        if not data:
            _fail(422, "file is empty", "empty_file")

        try:
            parsed = await run_in_threadpool(parse_document, file.filename, data)
        except UnsupportedDocument as exc:
            _fail(415, str(exc), "unsupported_file_type")
        except DocumentParseError as exc:
            _fail(422, str(exc), "parse_failed")

        try:
            pieces = chunk_text(parsed.text, resolved.chunk_size, resolved.chunk_overlap)
        except ValueError as exc:
            _fail(422, str(exc), "chunk_failed")
        if not pieces:
            _fail(422, "the document produced no text chunks", "empty_document")
        if len(pieces) > resolved.max_chunks_per_document:
            _fail(413, "the document produces too many chunks", "too_many_chunks")

        embedder = request.app.state.embedder
        vectors = await run_in_threadpool(embedder.embed, pieces)
        if len(vectors) != len(pieces):
            _fail(500, "embedding count does not match chunk count", "embedding_error")

        return ExtractionResponse(
            documentId=document_id,
            filename=file.filename,
            text=parsed.text,
            pageCount=parsed.page_count,
            charCount=len(parsed.text),
            chunks=[
                ChunkResponse(seq=index, text=piece, embedding=vector)
                for index, (piece, vector) in enumerate(zip(pieces, vectors))
            ],
            embeddingModel=embedder.model_name,
            embeddingBackend=embedder.backend,
            dimensions=embedder.dimensions,
            metadata=parsed.metadata,
        )

    @app.post(
        "/search",
        response_model=SearchResponse,
        dependencies=[Depends(require_token)],
    )
    async def search(request: Request, payload: SearchRequest) -> SearchResponse:
        if len(payload.chunks) > resolved.max_search_chunks:
            _fail(413, "too many candidate chunks", "too_many_chunks")

        embedder = request.app.state.embedder
        query_vector = (await run_in_threadpool(embedder.embed, [payload.query]))[0]

        def rank() -> list[SearchResult]:
            scored: list[SearchResult] = []
            for chunk in payload.chunks:
                if len(chunk.embedding) != len(query_vector):
                    continue
                score = cosine_similarity(query_vector, chunk.embedding)
                scored.append(SearchResult(id=chunk.id, score=round(score, 8)))
            scored.sort(key=lambda item: item.score, reverse=True)
            return scored[: payload.limit]

        results = await run_in_threadpool(rank)
        return SearchResponse(
            model=embedder.model_name,
            dimensions=embedder.dimensions,
            results=results,
        )

    @app.exception_handler(Exception)
    async def unhandled_error(request: Request, exc: Exception) -> JSONResponse:
        logger.error(
            "unhandled extractor error",
            exc_info=(type(exc), exc, exc.__traceback__),
        )
        return JSONResponse(
            status_code=500,
            content={"detail": {"message": "internal_error", "code": "internal_error"}},
        )

    return app


app = create_app()
