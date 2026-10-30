export class ExtractorError extends Error {
  constructor(message, { status = 0, details = null } = {}) {
    super(message);
    this.name = "ExtractorError";
    this.status = status;
    this.details = details;
  }
}

function checkedEmbedding(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8192) {
    throw new ExtractorError("extractor returned an invalid embedding");
  }
  return value.map((item) => {
    const number = Number(item);
    if (!Number.isFinite(number)) {
      throw new ExtractorError("extractor returned a non-numeric embedding");
    }
    return number;
  });
}

export function createExtractorClient({ baseUrl, token, timeoutMs = 120_000 }) {
  async function request(path, options = {}, requestTimeoutMs = timeoutMs) {
    let response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        ...options,
        headers: {
          "x-internal-token": token,
          ...(options.headers ?? {}),
        },
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch (error) {
      throw new ExtractorError(`extractor request failed: ${error.message}`);
    }

    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { raw: text };
      }
    }
    if (!response.ok) {
      const detail = payload?.detail;
      const message =
        (typeof detail === "object" ? detail?.message : detail) ??
        payload?.error ??
        `extractor responded with ${response.status}`;
      throw new ExtractorError(String(message), {
        status: response.status,
        details: payload,
      });
    }
    return payload ?? {};
  }

  return {
    async extract({ tenantId, documentId, filePath, filename, contentType }) {
      const { readFile } = await import("node:fs/promises");
      const bytes = await readFile(filePath);
      const form = new FormData();
      form.append("tenant_id", tenantId);
      form.append("document_id", documentId);
      form.append("file", new Blob([bytes], { type: contentType }), filename);
      const payload = await request("/extract", { method: "POST", body: form });
      if (typeof payload.text !== "string" || !Array.isArray(payload.chunks)) {
        throw new ExtractorError("extractor returned an incomplete response");
      }
      const model = String(payload.embeddingModel ?? payload.embedding_model ?? "").trim();
      if (!model) {
        throw new ExtractorError("extractor did not report an embedding model");
      }
      const chunks = payload.chunks.map((chunk, index) => {
        const text = String(chunk?.text ?? "").trim();
        if (!text) {
          throw new ExtractorError("extractor returned an empty chunk");
        }
        return {
          seq: Number.isInteger(chunk.seq) ? chunk.seq : index,
          text,
          embedding: checkedEmbedding(chunk.embedding),
        };
      });
      return {
        text: payload.text,
        pageCount: Number(payload.pageCount ?? payload.page_count ?? 0),
        charCount: Number(payload.charCount ?? payload.char_count ?? payload.text.length),
        chunks,
        embeddingModel: model,
        metadata: payload.metadata ?? {},
      };
    },

    async search({ tenantId, query, chunks, limit }) {
      const payload = await request("/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tenantId, query, limit, chunks }),
      });
      if (!Array.isArray(payload.results)) {
        throw new ExtractorError("extractor returned an invalid search response");
      }
      return {
        model: String(payload.model ?? ""),
        dimensions: Number(payload.dimensions ?? 0),
        results: payload.results.map((item) => ({
          id: String(item?.id ?? ""),
          score: Number(item?.score ?? 0),
        })),
      };
    },

    async health() {
      return request("/health", { method: "GET" }, 5000);
    },
  };
}
