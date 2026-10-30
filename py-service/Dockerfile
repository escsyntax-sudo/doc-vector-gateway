FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

WORKDIR /app

COPY pyproject.toml ./
COPY doc_service ./doc_service

ARG INSTALL_ML=false
RUN if [ "$INSTALL_ML" = "true" ]; then \
      pip install --no-cache-dir ".[ml]"; \
    else \
      pip install --no-cache-dir .; \
    fi

RUN useradd --create-home --shell /usr/sbin/nologin appuser \
    && chown -R appuser:appuser /app

ENV DOC_ENV=production
ENV DOC_EMBEDDING_BACKEND=auto

USER appuser

EXPOSE 8000

CMD ["uvicorn", "doc_service.main:app", "--host", "0.0.0.0", "--port", "8000"]
