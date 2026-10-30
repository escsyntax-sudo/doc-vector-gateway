import { randomUUID } from "node:crypto";

const DOCUMENT_COLUMNS = `
  id, tenant_id AS tenantId, filename, content_type AS contentType, size, sha256,
  status, page_count AS pageCount, char_count AS charCount, error,
  created_at AS createdAt, updated_at AS updatedAt
`;

const EXPORT_COLUMNS = `
  id, tenant_id AS tenantId, status, format, local_path AS localPath,
  s3_uri AS s3Uri, bytes, error, created_at AS createdAt, updated_at AS updatedAt
`;

function now() {
  return Date.now();
}

export class Store {
  constructor(db) {
    this.db = db;
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tenants (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        api_key_hash TEXT NOT NULL UNIQUE,
        webhook_secret TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        content_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        status TEXT NOT NULL,
        page_count INTEGER NOT NULL DEFAULT 0,
        char_count INTEGER NOT NULL DEFAULT 0,
        text TEXT NOT NULL DEFAULT '',
        local_path TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS documents_tenant_created
        ON documents (tenant_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        text TEXT NOT NULL,
        embedding TEXT NOT NULL,
        embedding_model TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS chunks_tenant_document
        ON chunks (tenant_id, document_id, seq);

      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_run_at INTEGER NOT NULL,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (tenant_id, document_id, kind)
      );

      CREATE INDEX IF NOT EXISTS jobs_due
        ON jobs (status, next_run_at);

      CREATE TABLE IF NOT EXISTS webhook_events (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS webhook_events_tenant_created
        ON webhook_events (tenant_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS exports (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        format TEXT NOT NULL,
        local_path TEXT,
        s3_uri TEXT,
        bytes INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS exports_tenant_created
        ON exports (tenant_id, created_at DESC);
    `);
  }

  upsertTenant({ id, name, apiKeyHash, webhookSecret }) {
    const stamp = now();
    this.db
      .prepare(
        `INSERT INTO tenants (id, name, api_key_hash, webhook_secret, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           api_key_hash = excluded.api_key_hash,
           webhook_secret = excluded.webhook_secret`,
      )
      .run(id, name, apiKeyHash, webhookSecret, stamp);
  }

  findTenantByKeyHash(hash) {
    return (
      this.db
        .prepare(
          `SELECT id, name, api_key_hash AS apiKeyHash, webhook_secret AS webhookSecret
           FROM tenants WHERE api_key_hash = ?`,
        )
        .get(hash) ?? null
    );
  }

  getTenant(id) {
    return (
      this.db
        .prepare(
          `SELECT id, name, api_key_hash AS apiKeyHash, webhook_secret AS webhookSecret
           FROM tenants WHERE id = ?`,
        )
        .get(id) ?? null
    );
  }

  createDocument({ id = randomUUID(), tenantId, filename, contentType, size, sha256, localPath, status = "pending" }) {
    const stamp = now();
    this.db
      .prepare(
        `INSERT INTO documents
          (id, tenant_id, filename, content_type, size, sha256, status, local_path, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, tenantId, filename, contentType, size, sha256, status, localPath, stamp, stamp);
    return this.getDocument(tenantId, id);
  }

  getDocument(tenantId, id) {
    return (
      this.db
        .prepare(
          `SELECT ${DOCUMENT_COLUMNS}, text, local_path AS localPath FROM documents
           WHERE tenant_id = ? AND id = ?`,
        )
        .get(tenantId, id) ?? null
    );
  }

  listDocuments(tenantId, { limit = 50, offset = 0, status = null } = {}) {
    if (status) {
      return this.db
        .prepare(
          `SELECT ${DOCUMENT_COLUMNS} FROM documents
           WHERE tenant_id = ? AND status = ?
           ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        )
        .all(tenantId, status, limit, offset);
    }
    return this.db
      .prepare(
        `SELECT ${DOCUMENT_COLUMNS} FROM documents
         WHERE tenant_id = ?
         ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(tenantId, limit, offset);
  }

  countDocuments(tenantId) {
    return this.db
      .prepare("SELECT COUNT(*) AS count FROM documents WHERE tenant_id = ?")
      .get(tenantId).count;
  }

  setDocumentProcessing(tenantId, id) {
    this.db
      .prepare(
        `UPDATE documents SET status = 'processing', error = NULL, updated_at = ?
         WHERE tenant_id = ? AND id = ?`,
      )
      .run(now(), tenantId, id);
  }

  setDocumentReady(tenantId, id, { text, pageCount, charCount }) {
    this.db
      .prepare(
        `UPDATE documents SET status = 'ready', text = ?, page_count = ?, char_count = ?,
         error = NULL, updated_at = ? WHERE tenant_id = ? AND id = ?`,
      )
      .run(text, pageCount, charCount, now(), tenantId, id);
  }

  setDocumentPending(tenantId, id, error) {
    this.db
      .prepare(
        `UPDATE documents SET status = 'pending', error = ?, updated_at = ?
         WHERE tenant_id = ? AND id = ?`,
      )
      .run(error ?? null, now(), tenantId, id);
  }

  setDocumentFailed(tenantId, id, error) {
    this.db
      .prepare(
        `UPDATE documents SET status = 'failed', error = ?, updated_at = ?
         WHERE tenant_id = ? AND id = ?`,
      )
      .run(error ?? null, now(), tenantId, id);
  }

  deleteDocument(tenantId, id) {
    const result = this.db
      .prepare("DELETE FROM documents WHERE tenant_id = ? AND id = ?")
      .run(tenantId, id);
    return result.changes > 0;
  }

  replaceChunks(tenantId, documentId, chunks, model) {
    const stamp = now();
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare("DELETE FROM chunks WHERE tenant_id = ? AND document_id = ?")
        .run(tenantId, documentId);
      const insert = this.db.prepare(
        `INSERT INTO chunks
          (id, tenant_id, document_id, seq, text, embedding, embedding_model, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      chunks.forEach((chunk, index) => {
        insert.run(
          randomUUID(),
          tenantId,
          documentId,
          index,
          chunk.text,
          JSON.stringify(chunk.embedding),
          model,
          stamp,
        );
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getChunks(tenantId, { documentId = null, limit = 5000 } = {}) {
    const rows = documentId
      ? this.db
          .prepare(
            `SELECT c.id, c.document_id AS documentId, c.seq, c.text, c.embedding,
                    c.embedding_model AS embeddingModel, d.filename
             FROM chunks c JOIN documents d ON d.id = c.document_id
             WHERE c.tenant_id = ? AND c.document_id = ?
             ORDER BY c.seq LIMIT ?`,
          )
          .all(tenantId, documentId, limit)
      : this.db
          .prepare(
            `SELECT c.id, c.document_id AS documentId, c.seq, c.text, c.embedding,
                    c.embedding_model AS embeddingModel, d.filename
             FROM chunks c JOIN documents d ON d.id = c.document_id
             WHERE c.tenant_id = ?
             ORDER BY d.created_at DESC, c.seq LIMIT ?`,
          )
          .all(tenantId, limit);

    return rows.map((row) => ({ ...row, embedding: JSON.parse(row.embedding) }));
  }

  countChunks(tenantId) {
    return this.db
      .prepare("SELECT COUNT(*) AS count FROM chunks WHERE tenant_id = ?")
      .get(tenantId).count;
  }

  getDocumentChunks(tenantId, documentId) {
    return this.getChunks(tenantId, { documentId, limit: 100000 });
  }

  enqueueJob(tenantId, documentId, kind = "extract") {
    const id = randomUUID();
    const stamp = now();
    this.db
      .prepare(
        `INSERT INTO jobs
          (id, tenant_id, document_id, kind, status, attempts, next_run_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'queued', 0, ?, ?, ?)
         ON CONFLICT(tenant_id, document_id, kind) DO UPDATE SET
           status = 'queued',
           next_run_at = excluded.next_run_at,
           last_error = NULL,
           updated_at = excluded.updated_at`,
      )
      .run(id, tenantId, documentId, kind, stamp, stamp, stamp);
    return id;
  }

  claimNextJob(at = now()) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const job = this.db
        .prepare(
          `SELECT id, tenant_id AS tenantId, document_id AS documentId, kind, attempts,
                  next_run_at AS nextRunAt
           FROM jobs
           WHERE status = 'queued' AND next_run_at <= ?
           ORDER BY next_run_at LIMIT 1`,
        )
        .get(at);
      if (!job) {
        this.db.exec("COMMIT");
        return null;
      }
      this.db
        .prepare(
          `UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = ?
           WHERE id = ?`,
        )
        .run(now(), job.id);
      this.db.exec("COMMIT");
      return { ...job, attempts: job.attempts + 1 };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  completeJob(id) {
    this.db
      .prepare("UPDATE jobs SET status = 'done', last_error = NULL, updated_at = ? WHERE id = ?")
      .run(now(), id);
  }

  retryJob(id, error, delayMs) {
    const stamp = now();
    this.db
      .prepare(
        `UPDATE jobs SET status = 'queued',
         next_run_at = ?, last_error = ?, updated_at = ? WHERE id = ?`,
      )
      .run(stamp + delayMs, error, stamp, id);
  }

  failJob(id, error) {
    this.db
      .prepare(
        `UPDATE jobs SET status = 'failed',
         last_error = ?, updated_at = ? WHERE id = ?`,
      )
      .run(error, now(), id);
  }

  requeueStaleJobs(cutoff) {
    return this.db
      .prepare(
        `UPDATE jobs SET status = 'queued', next_run_at = ?, updated_at = ?
         WHERE status = 'running' AND updated_at < ?`,
      )
      .run(now(), now(), cutoff).changes;
  }

  requeueFailedJobs(maxAttempts) {
    const jobs = this.db
      .prepare(
        `SELECT id, tenant_id AS tenantId, document_id AS documentId
         FROM jobs WHERE status = 'failed' AND attempts < ?`,
      )
      .all(maxAttempts);
    const stamp = now();
    const requeue = this.db.prepare(
      `UPDATE jobs SET status = 'queued', next_run_at = ?, updated_at = ? WHERE id = ?`,
    );
    const resetDocument = this.db.prepare(
      `UPDATE documents SET status = 'pending', error = NULL, updated_at = ?
       WHERE tenant_id = ? AND id = ? AND status = 'failed'`,
    );
    this.db.exec("BEGIN");
    try {
      for (const job of jobs) {
        requeue.run(stamp, stamp, job.id);
        resetDocument.run(stamp, job.tenantId, job.documentId);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return jobs.length;
  }

  addWebhookEvent({ tenantId, provider, eventType, payload }) {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO webhook_events (id, tenant_id, provider, event_type, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, tenantId, provider, eventType, JSON.stringify(payload), now());
    return id;
  }

  listWebhookEvents(tenantId, { limit = 50 } = {}) {
    return this.db
      .prepare(
        `SELECT id, provider, event_type AS eventType, payload, created_at AS createdAt
         FROM webhook_events WHERE tenant_id = ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(tenantId, limit)
      .map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
  }

  createExport({ tenantId, format }) {
    const id = randomUUID();
    const stamp = now();
    this.db
      .prepare(
        `INSERT INTO exports (id, tenant_id, status, format, created_at, updated_at)
         VALUES (?, ?, 'processing', ?, ?, ?)`,
      )
      .run(id, tenantId, format, stamp, stamp);
    return this.getExport(tenantId, id);
  }

  getExport(tenantId, id) {
    return (
      this.db
        .prepare(`SELECT ${EXPORT_COLUMNS} FROM exports WHERE tenant_id = ? AND id = ?`)
        .get(tenantId, id) ?? null
    );
  }

  markExportReady(id, { bytes, localPath, s3Uri }) {
    this.db
      .prepare(
        `UPDATE exports SET status = 'ready', bytes = ?, local_path = ?, s3_uri = ?,
         error = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(bytes, localPath, s3Uri ?? null, now(), id);
  }

  markExportFailed(id, error) {
    this.db
      .prepare("UPDATE exports SET status = 'failed', error = ?, updated_at = ? WHERE id = ?")
      .run(error, now(), id);
  }

  listExports(tenantId, { limit = 50 } = {}) {
    return this.db
      .prepare(
        `SELECT ${EXPORT_COLUMNS} FROM exports WHERE tenant_id = ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(tenantId, limit);
  }

  deleteOldExports(cutoff) {
    const rows = this.db
      .prepare(
        `SELECT ${EXPORT_COLUMNS} FROM exports
         WHERE created_at < ? AND status IN ('ready', 'failed')`,
      )
      .all(cutoff);
    const remove = this.db.prepare("DELETE FROM exports WHERE id = ?");
    this.db.exec("BEGIN");
    try {
      for (const row of rows) {
        remove.run(row.id);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return rows;
  }

  tenantStats(tenantId) {
    return {
      documents: this.countDocuments(tenantId),
      chunks: this.countChunks(tenantId),
      exports: this.db
        .prepare("SELECT COUNT(*) AS count FROM exports WHERE tenant_id = ?")
        .get(tenantId).count,
      webhookEvents: this.db
        .prepare("SELECT COUNT(*) AS count FROM webhook_events WHERE tenant_id = ?")
        .get(tenantId).count,
    };
  }
}
