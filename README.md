# DOC Vector Gateway

A multi-tenant document gateway that ingests files, extracts text in a Python service, stores embeddings in SQLite, and serves ranked search results through a Node.js API. It also verifies CRM webhooks, retries failed jobs on a CRON schedule, and exports tenant data as JSONL to local storage or S3.

The Node process owns authentication, tenant isolation, uploads, job state, and persistence. The Python process owns parsing, chunking, and embeddings. The two communicate over a private REST contract protected by a shared internal token.

## Architecture

```text
client
  |
  | Bearer tenant API key
  v
Node orchestrator (Fastify)
  |        |          |
  |        |          +--> SQLite: tenants, documents, chunks, jobs, webhooks, exports
  |        |
  |        +--> local uploads and JSONL exports, optional S3 upload
  |
  | x-internal-token, multipart and JSON
  v
Python extractor (FastAPI)
  |
  +--> pdfplumber and PyPDF2 for PDF
  +--> openpyxl for XLSX
  +--> sentence-transformers when installed, hash vectors otherwise
```

The gateway sends a query and the tenant's candidate chunks to the Python search endpoint. Python embeds the query, scores the candidates, and returns ranked IDs. The gateway joins the IDs back to document metadata before responding.

## Repository layout

- `node-orchestrator`: Fastify API, SQLite schema, job runner, CRON scheduler, webhook verification, S3 export.
- `py-service`: FastAPI endpoints, parsers, chunking, embedding backends, tests.
- `docker-compose.yml`: both services on a private network with a persistent data volume.

## Requirements

- Node.js 24 or newer, because the gateway uses the built-in `node:sqlite` module.
- Python 3.11 or newer.
- Docker Compose is optional.

## Local quick start

Start the extractor:

```bash
cd py-service
python -m venv .venv
.venv\Scripts\activate
pip install -e ".[dev]"
set DOC_INTERNAL_TOKEN=dev-internal-token
uvicorn doc_service.main:app --port 8000
```

On macOS or Linux use `source .venv/bin/activate` and `export DOC_INTERNAL_TOKEN=dev-internal-token`.

Start the gateway in another terminal:

```bash
cd node-orchestrator
npm install
set DOC_INTERNAL_TOKEN=dev-internal-token
npm start
```

PowerShell uses `$env:DOC_INTERNAL_TOKEN = "dev-internal-token"`.

In development the gateway creates a tenant with id `demo` and API key `demo-key`. The tenant is seeded only when `DOC_TENANTS` is unset. Production refuses to start without explicit tenants and a non-default internal token.

Upload a file:

```bash
curl -H "Authorization: Bearer demo-key" -F "file=@notes.txt" http://127.0.0.1:8080/v1/documents
```

The response is `202` with a document id. Extraction runs in the background. Poll the document until its status is `ready`:

```bash
curl -H "Authorization: Bearer demo-key" http://127.0.0.1:8080/v1/documents/<id>
```

Search the tenant's documents:

```bash
curl -H "Authorization: Bearer demo-key" \
  -H "Content-Type: application/json" \
  -d '{"query":"revenue outlook","limit":5}' \
  http://127.0.0.1:8080/v1/search
```

## Docker Compose

```bash
cd doc
copy .env.example .env
docker compose up --build
```

Edit `.env` first. `DOC_TENANTS` is a JSON array and `DOC_INTERNAL_TOKEN` is shared by both services. The gateway is published on `http://127.0.0.1:8080`.

To use sentence-transformers in the container, set `INSTALL_ML=true`. The image then installs the optional ML dependencies, which include PyTorch. Expect a large image and a first-run model download.

The named volume `doc-data` keeps SQLite, uploads, and local exports across restarts.

## Tenants and authentication

Clients authenticate with `Authorization: Bearer <apiKey>`. The gateway hashes the presented key with SHA-256 and looks up the tenant by that hash. API keys are not stored in plaintext. The authenticated tenant scopes every document, chunk, webhook, export, and search query.

`DOC_TENANTS` must be a JSON array:

```json
[
  {
    "id": "acme",
    "name": "Acme Legal",
    "apiKey": "replace-with-a-random-32-char-key",
    "webhookSecret": "replace-with-a-random-webhook-secret"
  }
]
```

Tenant ids use lowercase letters, numbers, underscores, and hyphens. The id must start with a letter or number and be 2 to 64 characters long. API keys and webhook secrets must each be at least 12 characters. In production, use long random values.

The tenant is derived from the API key. A client cannot select another tenant with a header on normal API routes.

## HTTP API

All `/v1` routes require a bearer token. Errors use a JSON object with an `error` field. Validation errors include a `details` array.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/healthz` | Gateway, database, and extractor health |
| `GET` | `/v1/tenants/me` | Current tenant and record counts |
| `POST` | `/v1/documents` | Upload one file as multipart field `file` |
| `GET` | `/v1/documents` | List documents, supports `limit`, `offset`, `status` |
| `GET` | `/v1/documents/:id` | Document metadata |
| `GET` | `/v1/documents/:id/text` | Extracted text and chunk text |
| `DELETE` | `/v1/documents/:id` | Delete a document, chunks, jobs, and stored file |
| `POST` | `/v1/search` | Rank chunks for a query |
| `POST` | `/v1/exports` | Create a JSONL export |
| `GET` | `/v1/exports` | List exports |
| `GET` | `/v1/exports/:id/download` | Download a local export |
| `GET` | `/v1/webhooks` | List verified CRM webhook events |
| `POST` | `/webhooks/crm/:provider` | Receive a signed CRM webhook |

### Uploads

Accepted extensions are `.pdf`, `.txt`, `.md`, `.csv`, and `.xlsx`. The default size limit is 20 MiB. Files are written under `DOC_DATA_DIR/uploads/<tenant>/<document>`. The database stores the SHA-256 digest, byte size, content type, status, and extraction error.

Document states are `pending`, `processing`, `ready`, and `failed`. A failed extraction is retried with exponential backoff up to `DOC_JOB_MAX_ATTEMPTS`.

### Search

Request:

```json
{
  "query": "termination clause",
  "limit": 10,
  "documentId": "optional-document-id"
}
```

The gateway loads at most `DOC_MAX_SEARCH_CHUNKS` candidate chunks for the tenant, sends them to the extractor with the query, and returns the highest scoring chunks. Response fields include `model`, `dimensions`, `scannedChunks`, `truncated`, and `results`. Each result includes `chunkId`, `documentId`, `filename`, `seq`, `score`, and `text`.

When the tenant has no chunks, the endpoint returns an empty result without calling the extractor.

The search is exact nearest-neighbor over the stored chunks. It is not an approximate index. This keeps the stack simple and honest at small and medium corpus sizes. A large tenant should replace the candidate scan with a real vector index.

### Exports

Create an export:

```bash
curl -X POST -H "Authorization: Bearer demo-key" \
  -H "Content-Type: application/json" \
  -d '{"includeText":true,"includeEmbeddings":false}' \
  http://127.0.0.1:8080/v1/exports
```

The export is newline-delimited JSON. Each document starts with a `document` record. Its chunks follow as `chunk` records. Embeddings are omitted unless `includeEmbeddings` is true. Text is included unless `includeText` is false.

Files are written to `DOC_DATA_DIR/exports/<tenant>/<export>.jsonl`. When `DOC_S3_BUCKET` is set, the gateway uploads the same file with `PutObjectCommand` and records an `s3://` URI. Credentials come from the standard AWS SDK provider chain. The local copy remains available for download and is removed by the cleanup schedule.

### CRM webhooks

Webhook senders identify the tenant with `x-tenant-id` and sign the exact request body:

```text
x-crm-signature: sha256=<hex HMAC-SHA256(webhookSecret, rawBody)>
x-crm-event: document.ready
content-type: application/json

{"type":"document.ready","documentId":"<id>","crm":"hubspot"}
```

The signature is verified with a constant-time comparison before the body is processed. Missing tenants, unknown secrets, and malformed signatures return `401`.

Every verified event is stored for the tenant. When the event type is `document.ready`, `document.updated`, or `reindex.requested` and the body has a `documentId` that belongs to the tenant, the document is requeued for extraction. Other event types are recorded without side effects.

Example signature with OpenSSL:

```bash
signature=$(openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" -binary body.json | xxd -p -c 256)
curl -X POST \
  -H "x-tenant-id: acme" \
  -H "x-crm-event: document.ready" \
  -H "x-crm-signature: sha256=$signature" \
  -H "Content-Type: application/json" \
  --data-binary @body.json \
  http://127.0.0.1:8080/webhooks/crm/hubspot
```

## Extraction and embeddings

PDF text extraction tries pdfplumber first and PyPDF2 second. If both return no text, the document fails with a message that scanned PDFs need OCR. The service does not pretend to extract scanned pages.

XLSX files are read with openpyxl in read-only, data-only mode. Each sheet becomes a `Sheet: <name>` section and non-empty rows are joined with `|`. Text, Markdown, and CSV files are decoded as UTF-8 with a Windows-1252 fallback.

Text is normalized, split into overlapping character chunks, and embedded. The defaults are 1200 characters per chunk with a 200 character overlap. Settings are validated at startup.

Embedding backends:

| Backend | Behavior |
| --- | --- |
| `sentence-transformers` | Load `DOC_EMBEDDING_MODEL` and fail startup if the package or model cannot load |
| `hash` | Deterministic signed hashing vectors over words, word pairs, and character trigrams |
| `auto` | Try sentence-transformers, fall back to hash vectors with a warning |

The hash backend is a lexical approximation. It is deterministic, dependency-light, and useful for tests and small deployments, but it is not a semantic model. Install the optional ML dependencies to use the real model:

```bash
cd py-service
pip install -e ".[ml]"
set DOC_EMBEDDING_BACKEND=sentence-transformers
uvicorn doc_service.main:app --port 8000
```

The service reports the active backend and dimensions on `/health`, and every extraction response names the model that produced its vectors. Reindex a tenant after changing the backend because vectors from different models are not comparable.

## Jobs, retries, and CRON

Uploads and reindex webhooks create rows in `jobs`. The in-process runner claims due jobs, marks the document `processing`, calls the extractor, replaces the document's chunks, and marks it `ready`.

On failure, the job is retried with a 1 second, 2 second, 4 second backoff, capped at 60 seconds. After `DOC_JOB_MAX_ATTEMPTS`, the job and document are marked `failed` with the error text.

The CRON scheduler runs:

- Every 5 minutes: requeue running jobs older than 15 minutes and failed jobs that still have attempts left.
- Every day at 03:00: remove export rows and local files older than `DOC_EXPORT_RETENTION_DAYS`.

Set `DOC_CRON_ENABLED=false` to disable both schedules.

## Configuration

Gateway variables:

| Name | Default | Purpose |
| --- | --- | --- |
| `NODE_ENV` | `development` | Production requires tenants and a non-default internal token |
| `PORT` | `8080` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `DOC_DATA_DIR` | `./data` | SQLite, uploads, and exports |
| `DOC_DB_PATH` | `<data>/doc-vectors.db` | SQLite file |
| `DOC_EXTRACTOR_URL` | `http://127.0.0.1:8000` | Python service base URL |
| `DOC_INTERNAL_TOKEN` | `dev-internal-token` | Shared service token |
| `DOC_TENANTS` | unset | JSON tenant array, required in production |
| `DOC_MAX_UPLOAD_BYTES` | `20971520` | Multipart file limit |
| `DOC_MAX_SEARCH_CHUNKS` | `5000` | Candidate chunks per search |
| `DOC_MAX_SEARCH_LIMIT` | `50` | Maximum result count |
| `DOC_JOB_MAX_ATTEMPTS` | `3` | Extraction attempts |
| `DOC_JOB_POLL_MS` | `1000` | Job polling interval |
| `DOC_CRON_ENABLED` | `true` | Enable scheduled maintenance |
| `DOC_EXPORT_RETENTION_DAYS` | `7` | Export cleanup age |
| `DOC_S3_BUCKET` | unset | Enable S3 uploads |
| `DOC_S3_REGION` | `us-east-1` | S3 region |
| `DOC_S3_PREFIX` | `doc-vector-exports` | Object key prefix |
| `DOC_S3_ENDPOINT` | unset | Custom S3 endpoint, enables path-style access |
| `CORS_ORIGIN` | unset | Single allowed browser origin |
| `LOG_LEVEL` | `info` | Fastify log level |

Extractor variables:

| Name | Default | Purpose |
| --- | --- | --- |
| `DOC_ENV` | `development` | Production rejects the default internal token |
| `DOC_INTERNAL_TOKEN` | `dev-internal-token` | Must match the gateway |
| `DOC_MAX_UPLOAD_BYTES` | `20971520` | Extraction size limit |
| `DOC_MAX_CHUNKS` | `2000` | Chunks allowed per document |
| `DOC_MAX_SEARCH_CHUNKS` | `5000` | Candidate limit |
| `DOC_CHUNK_SIZE` | `1200` | Characters per chunk |
| `DOC_CHUNK_OVERLAP` | `200` | Overlap between chunks |
| `DOC_EMBEDDING_BACKEND` | `auto` | `auto`, `hash`, or `sentence-transformers` |
| `DOC_EMBEDDING_MODEL` | `sentence-transformers/all-MiniLM-L6-v2` | Model name |
| `DOC_EMBEDDING_BATCH` | `32` | Encode batch size |
| `DOC_HASH_DIMENSIONS` | `384` | Hash vector size |

## Tests

Gateway:

```bash
cd node-orchestrator
npm test
```

Extractor:

```bash
cd py-service
.venv\Scripts\python.exe -m pytest
.venv\Scripts\ruff.exe check .
```

The gateway suite covers authentication, upload, extraction job completion, tenant isolation, unsupported file types, search proxying, webhook signatures, export download isolation, health, and failure state. The extractor suite covers plain text, XLSX, PDF text extraction, authorization, upload limits, chunking, hashing vectors, search ranking, and health.

Docker and S3 are not exercised by the test suites. Tests use temporary SQLite databases, temporary data directories, and an in-process fake extractor for the gateway suite.

## Security notes

- Tenant API keys are stored as SHA-256 hashes. Webhook secrets are stored in plaintext because HMAC verification needs them. Protect the SQLite file.
- Static bearer keys are simple to operate but cannot be rotated per session. Add an identity provider if you need short-lived credentials and audit trails.
- The Python service trusts `DOC_INTERNAL_TOKEN`. Keep it on a private network and never publish port 8000.
- Uploads are checked by extension and size, not scanned for malware. Add a scanner before accepting untrusted files from the public internet.
- The gateway has no request-level audit log beyond application logs and stored webhook events.
- S3 uploads use the SDK credential chain. No credentials are stored in the database.
- There is no OCR. Scanned PDFs fail clearly instead of returning empty text.

## Scaling notes

- One gateway process owns the job runner. Running multiple gateway instances against the same SQLite file is not supported.
- SQLite with WAL is a deliberate small-deployment choice. Move to Postgres when you need concurrent writers or horizontal scale.
- Search scans the tenant's stored chunks. Add a vector index and tenant-aware partitioning before large corpora.
- The extractor is stateless and can be replicated behind a load balancer. Keep the internal token shared and the network private.
