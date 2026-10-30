import { createReadStream } from "node:fs";
import { mkdir, open, rm, stat } from "node:fs/promises";
import path from "node:path";

function exportView(record) {
  if (!record) {
    return null;
  }
  const { localPath, ...rest } = record;
  return rest;
}

export function createExportService({ config, store, logger }) {
  async function uploadToS3(localPath, tenantId, exportId) {
    if (!config.s3.bucket) {
      return null;
    }
    const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
    const client = new S3Client({
      region: config.s3.region,
      endpoint: config.s3.endpoint ?? undefined,
      forcePathStyle: Boolean(config.s3.endpoint),
    });
    const key = `${config.s3.prefix}/${tenantId}/${exportId}.jsonl`;
    await client.send(
      new PutObjectCommand({
        Bucket: config.s3.bucket,
        Key: key,
        Body: createReadStream(localPath),
        ContentType: "application/x-ndjson",
      }),
    );
    return `s3://${config.s3.bucket}/${key}`;
  }

  return {
    async run(tenantId, { includeText = true, includeEmbeddings = false } = {}) {
      const record = store.createExport({ tenantId, format: "jsonl" });
      const folder = path.join(config.exportDir, tenantId);
      const localPath = path.join(folder, `${record.id}.jsonl`);
      await mkdir(folder, { recursive: true });
      const handle = await open(localPath, "w");
      try {
        const documents = store.listDocuments(tenantId, { limit: 100000, offset: 0 });
        for (const item of documents) {
          const document = store.getDocument(tenantId, item.id);
          const metadata = {
            ...exportView(document),
            text: includeText ? document.text : undefined,
          };
          if (!includeText) {
            delete metadata.text;
          }
          const lines = [JSON.stringify({ type: "document", document: metadata })];
          for (const chunk of store.getDocumentChunks(tenantId, item.id)) {
            lines.push(
              JSON.stringify({
                type: "chunk",
                documentId: item.id,
                seq: chunk.seq,
                text: chunk.text,
                embeddingModel: chunk.embeddingModel,
                embedding: includeEmbeddings ? chunk.embedding : undefined,
              }),
            );
          }
          await handle.write(`${lines.join("\n")}\n`);
        }
        await handle.close();
        const info = await stat(localPath);
        const s3Uri = await uploadToS3(localPath, tenantId, record.id);
        store.markExportReady(record.id, {
          bytes: info.size,
          localPath,
          s3Uri,
        });
        logger.info({ tenantId, exportId: record.id, bytes: info.size, s3Uri }, "export ready");
        return exportView(store.getExport(tenantId, record.id));
      } catch (error) {
        await handle.close().catch(() => {});
        await rm(localPath, { force: true }).catch(() => {});
        store.markExportFailed(record.id, error.message ?? String(error));
        logger.error({ tenantId, exportId: record.id, err: error }, "export failed");
        throw error;
      }
    },

    async cleanupOld() {
      const cutoff = Date.now() - config.exportRetentionDays * 24 * 60 * 60 * 1000;
      const rows = store.deleteOldExports(cutoff);
      for (const row of rows) {
        if (row.localPath) {
          await rm(row.localPath, { force: true }).catch(() => {});
        }
      }
      return rows.length;
    },
  };
}

export { exportView };
