import { ExtractorError } from "../lib/extractor.js";

const searchSchema = {
  type: "object",
  required: ["query"],
  additionalProperties: false,
  properties: {
    query: { type: "string", minLength: 1, maxLength: 2000 },
    limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
    documentId: { type: "string", minLength: 1, maxLength: 64 },
  },
};

export async function searchRoutes(app, { config, store, extractor, authenticate }) {
  app.post(
    "/v1/search",
    {
      preHandler: authenticate,
      schema: { body: searchSchema },
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const { query, limit = 10, documentId } = request.body;
      const tenantId = request.tenant.id;

      if (documentId) {
        const document = store.getDocument(tenantId, documentId);
        if (!document) {
          return reply.code(404).send({ error: "document_not_found" });
        }
      }

      const chunks = store.getChunks(tenantId, {
        documentId: documentId ?? null,
        limit: config.maxChunksPerSearch,
      });
      if (chunks.length === 0) {
        return {
          query,
          model: null,
          dimensions: 0,
          scannedChunks: 0,
          truncated: false,
          results: [],
        };
      }

      try {
        const response = await extractor.search({
          tenantId,
          query,
          limit: Math.min(limit, config.maxSearchLimit),
          chunks: chunks.map((chunk) => ({
            id: chunk.id,
            documentId: chunk.documentId,
            text: chunk.text,
            embedding: chunk.embedding,
          })),
        });
        const byId = new Map(chunks.map((chunk) => [chunk.id, chunk]));
        return {
          query,
          model: response.model,
          dimensions: response.dimensions,
          scannedChunks: chunks.length,
          truncated: chunks.length >= config.maxChunksPerSearch,
          results: response.results
            .filter((item) => byId.has(item.id))
            .map((item) => {
              const chunk = byId.get(item.id);
              return {
                chunkId: chunk.id,
                documentId: chunk.documentId,
                filename: chunk.filename,
                seq: chunk.seq,
                score: Number(item.score.toFixed(6)),
                text: chunk.text,
              };
            }),
        };
      } catch (error) {
        request.log.warn({ err: error, tenantId }, "search extraction call failed");
        if (error instanceof ExtractorError) {
          return reply.code(502).send({ error: "extractor_unavailable" });
        }
        throw error;
      }
    },
  );
}
