import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const ALLOWED_TYPES = new Map([
  [".pdf", "application/pdf"],
  [".txt", "text/plain"],
  [".md", "text/markdown"],
  [".csv", "text/csv"],
  [
    ".xlsx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ],
]);

function safeFilename(value) {
  const base = path.basename(String(value ?? "document"));
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "");
  return (cleaned || "document").slice(0, 180);
}

function publicDocument(document) {
  if (!document) {
    return null;
  }
  const { text, localPath, ...rest } = document;
  return rest;
}

const listQuery = {
  type: "object",
  additionalProperties: false,
  properties: {
    limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
    offset: { type: "integer", minimum: 0, default: 0 },
    status: { type: "string", enum: ["pending", "processing", "ready", "failed"] },
  },
};

const idParams = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", minLength: 1, maxLength: 64 } },
};

export async function documentRoutes(app, { config, store, authenticate, jobs }) {
  app.get(
    "/v1/documents",
    { preHandler: authenticate, schema: { querystring: listQuery } },
    async (request) => {
      const { limit = 50, offset = 0, status = null } = request.query;
      return {
        documents: store
          .listDocuments(request.tenant.id, { limit, offset, status })
          .map(publicDocument),
        total: store.countDocuments(request.tenant.id),
        limit,
        offset,
      };
    },
  );

  app.post(
    "/v1/documents",
    {
      preHandler: authenticate,
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      let part;
      try {
        part = await request.file();
      } catch (error) {
        if (error.code === "FST_REQ_FILE_TOO_LARGE") {
          return reply.code(413).send({ error: "file_too_large" });
        }
        throw error;
      }
      if (!part) {
        return reply.code(400).send({ error: "file_required" });
      }

      const original = safeFilename(part.filename);
      const extension = path.extname(original).toLowerCase();
      const contentType = ALLOWED_TYPES.get(extension);
      if (!contentType) {
        return reply.code(415).send({
          error: "unsupported_file_type",
          allowed: [...ALLOWED_TYPES.keys()],
        });
      }

      let buffer;
      try {
        buffer = await part.toBuffer();
      } catch (error) {
        if (error.code === "FST_REQ_FILE_TOO_LARGE") {
          return reply.code(413).send({ error: "file_too_large" });
        }
        throw error;
      }
      if (buffer.length === 0) {
        return reply.code(400).send({ error: "empty_file" });
      }
      if (buffer.length > config.maxUploadBytes) {
        return reply.code(413).send({ error: "file_too_large" });
      }

      const documentId = randomUUID();
      const tenantId = request.tenant.id;
      const folder = path.join(config.uploadDir, tenantId, documentId);
      const filePath = path.join(folder, original);
      await mkdir(folder, { recursive: true });
      await writeFile(filePath, buffer, { mode: 0o600 });

      let document;
      try {
        document = store.createDocument({
          id: documentId,
          tenantId,
          filename: original,
          contentType,
          size: buffer.length,
          sha256: createHash("sha256").update(buffer).digest("hex"),
          localPath: filePath,
        });
        store.enqueueJob(tenantId, documentId);
      } catch (error) {
        await rm(folder, { recursive: true, force: true });
        throw error;
      }

      jobs.kick();
      return reply.code(202).send({ document: publicDocument(document) });
    },
  );

  app.get(
    "/v1/documents/:id",
    { preHandler: authenticate, schema: { params: idParams } },
    async (request, reply) => {
      const document = store.getDocument(request.tenant.id, request.params.id);
      if (!document) {
        return reply.code(404).send({ error: "document_not_found" });
      }
      return { document: publicDocument(document) };
    },
  );

  app.get(
    "/v1/documents/:id/text",
    { preHandler: authenticate, schema: { params: idParams } },
    async (request, reply) => {
      const document = store.getDocument(request.tenant.id, request.params.id);
      if (!document) {
        return reply.code(404).send({ error: "document_not_found" });
      }
      return {
        document: publicDocument(document),
        text: document.text,
        chunks: store.getDocumentChunks(request.tenant.id, request.params.id).map((chunk) => ({
          seq: chunk.seq,
          text: chunk.text,
          model: chunk.embeddingModel,
        })),
      };
    },
  );

  app.delete(
    "/v1/documents/:id",
    { preHandler: authenticate, schema: { params: idParams } },
    async (request, reply) => {
      const document = store.getDocument(request.tenant.id, request.params.id);
      if (!document) {
        return reply.code(404).send({ error: "document_not_found" });
      }
      store.deleteDocument(request.tenant.id, request.params.id);
      if (document.localPath) {
        await rm(path.dirname(document.localPath), { recursive: true, force: true });
      }
      return reply.code(204).send();
    },
  );
}

export { publicDocument };
