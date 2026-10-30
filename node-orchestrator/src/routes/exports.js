import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { exportView } from "../lib/exporter.js";

const createSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    includeText: { type: "boolean", default: true },
    includeEmbeddings: { type: "boolean", default: false },
  },
};

const idParams = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", minLength: 1, maxLength: 64 } },
};

export async function exportRoutes(app, { store, authenticate, exporter }) {
  app.post(
    "/v1/exports",
    {
      preHandler: authenticate,
      schema: { body: createSchema },
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const { includeText = true, includeEmbeddings = false } = request.body ?? {};
      try {
        const record = await exporter.run(request.tenant.id, { includeText, includeEmbeddings });
        return reply.code(201).send({ export: record });
      } catch (error) {
        request.log.error({ err: error }, "export failed");
        if (error.name === "S3ServiceException" || error.$metadata) {
          return reply.code(502).send({ error: "export_storage_failed" });
        }
        return reply.code(500).send({ error: "export_failed" });
      }
    },
  );

  app.get("/v1/exports", { preHandler: authenticate }, async (request) => {
    return {
      exports: store.listExports(request.tenant.id).map(exportView),
    };
  });

  app.get(
    "/v1/exports/:id/download",
    { preHandler: authenticate, schema: { params: idParams } },
    async (request, reply) => {
      const record = store.getExport(request.tenant.id, request.params.id);
      if (!record || !record.localPath) {
        return reply.code(404).send({ error: "export_not_found" });
      }
      try {
        await access(record.localPath);
      } catch {
        return reply.code(404).send({ error: "export_file_missing" });
      }
      reply.header("content-type", "application/x-ndjson");
      reply.header("content-disposition", `attachment; filename="export-${record.id}.jsonl"`);
      return reply.send(createReadStream(record.localPath));
    },
  );
}
