from __future__ import annotations


def clean_text(text: str) -> str:
    normalized = text.replace("\x00", "").replace("\r\n", "\n").replace("\r", "\n")
    lines = [line.rstrip() for line in normalized.split("\n")]
    cleaned = "\n".join(lines)
    while "\n\n\n" in cleaned:
        cleaned = cleaned.replace("\n\n\n", "\n\n")
    return cleaned.strip()


def chunk_text(text: str, size: int = 1200, overlap: int = 200) -> list[str]:
    if size < 100:
        raise ValueError("chunk size must be at least 100")
    if overlap < 0 or overlap >= size:
        raise ValueError("overlap must be between 0 and size - 1")

    cleaned = clean_text(text)
    if not cleaned:
        return []
    if len(cleaned) <= size:
        return [cleaned]

    chunks: list[str] = []
    start = 0
    length = len(cleaned)
    while start < length:
        end = min(length, start + size)
        if end < length:
            search_from = start + int(size * 0.6)
            boundary = cleaned.rfind("\n\n", search_from, end)
            if boundary == -1:
                boundary = cleaned.rfind("\n", search_from, end)
            if boundary == -1:
                boundary = cleaned.rfind(" ", search_from, end)
            if boundary > start:
                end = boundary

        piece = cleaned[start:end].strip()
        if piece:
            chunks.append(piece)
        if end >= length:
            break

        next_start = max(end - overlap, start + 1)
        while next_start < end and not cleaned[next_start].isspace():
            next_start += 1
        while next_start < length and cleaned[next_start].isspace():
            next_start += 1
        start = next_start

    return chunks


def cosine_similarity(left: list[float], right: list[float]) -> float:
    if len(left) != len(right) or not left:
        return 0.0
    dot = 0.0
    left_norm = 0.0
    right_norm = 0.0
    for a, b in zip(left, right):
        dot += a * b
        left_norm += a * a
        right_norm += b * b
    if left_norm == 0.0 or right_norm == 0.0:
        return 0.0
    return dot / (left_norm**0.5 * right_norm**0.5)
