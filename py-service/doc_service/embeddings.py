from __future__ import annotations

import hashlib
import logging
import math
import re
import unicodedata
from itertools import pairwise

from .config import Settings

logger = logging.getLogger("doc_service.embeddings")

TOKEN_PATTERN = re.compile(r"\w+", re.UNICODE)


class HashingEmbedder:
    """Deterministic lexical vectors used when no neural model is installed."""

    backend = "hash"

    def __init__(self, dimensions: int = 384) -> None:
        if dimensions < 32:
            raise ValueError("hash dimensions must be at least 32")
        self.dimensions = dimensions
        self.model_name = f"hash-{dimensions}"

    def _features(self, text: str) -> list[tuple[str, float]]:
        normalized = unicodedata.normalize("NFKC", text).lower()
        tokens = TOKEN_PATTERN.findall(normalized)
        features: list[tuple[str, float]] = [(token, 1.0) for token in tokens]
        for left, right in pairwise(tokens):
            features.append((f"{left} {right}", 0.5))
        for token in tokens:
            if len(token) >= 5:
                for index in range(len(token) - 2):
                    features.append((f"#{token[index:index + 3]}", 0.25))
        return features

    def embed(self, texts: list[str]) -> list[list[float]]:
        vectors: list[list[float]] = []
        for text in texts:
            vector = [0.0] * self.dimensions
            counts: dict[str, float] = {}
            for feature, weight in self._features(text):
                counts[feature] = counts.get(feature, 0.0) + weight
            for feature, weight in counts.items():
                digest = hashlib.blake2b(feature.encode("utf-8"), digest_size=8).digest()
                number = int.from_bytes(digest, "big")
                index = number % self.dimensions
                sign = 1.0 if (number >> 63) == 0 else -1.0
                vector[index] += sign * (1.0 + math.log(weight))
            norm = math.sqrt(sum(item * item for item in vector))
            if norm > 0:
                vector = [item / norm for item in vector]
            vectors.append(vector)
        return vectors


class SentenceTransformerEmbedder:
    backend = "sentence-transformers"

    def __init__(self, model_name: str, batch_size: int) -> None:
        from sentence_transformers import SentenceTransformer

        self.model_name = model_name
        self.batch_size = batch_size
        self.model = SentenceTransformer(model_name)
        self.dimensions = int(self.model.get_sentence_embedding_dimension())

    def embed(self, texts: list[str]) -> list[list[float]]:
        vectors = self.model.encode(
            texts,
            batch_size=self.batch_size,
            normalize_embeddings=True,
            show_progress_bar=False,
            convert_to_numpy=True,
        )
        return [[float(value) for value in row] for row in vectors]


def create_embedder(settings: Settings) -> HashingEmbedder | SentenceTransformerEmbedder:
    if settings.embedding_backend == "hash":
        return HashingEmbedder(settings.hash_dimensions)

    try:
        embedder = SentenceTransformerEmbedder(
            settings.embedding_model,
            settings.embedding_batch_size,
        )
        logger.info("using sentence-transformers model %s", settings.embedding_model)
        return embedder
    except (ImportError, ModuleNotFoundError) as exc:
        if settings.embedding_backend == "sentence-transformers":
            raise RuntimeError(
                "sentence-transformers is not installed. Install the ml extra."
            ) from exc
        logger.warning(
            "sentence-transformers is unavailable, using hash-%d embeddings: %s",
            settings.hash_dimensions,
            exc,
        )
    except Exception as exc:
        if settings.embedding_backend == "sentence-transformers":
            raise RuntimeError(f"failed to load sentence-transformers: {exc}") from exc
        logger.warning(
            "sentence-transformers could not be loaded, using hash-%d embeddings: %s",
            settings.hash_dimensions,
            exc,
        )
    return HashingEmbedder(settings.hash_dimensions)
