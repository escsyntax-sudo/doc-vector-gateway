import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { buildApp } from "../src/app.js";
import { Store } from "../src/db.js";
import { createExportService } from "../src/lib/exporter.js";
import { JobRunner } from "../src/lib/jobs.js";

const ALPHA_KEY = "alpha-api-key-12345";
const BETA_KEY = "beta-api-key-12345";
const ALPHA_WEBHOOK = "alpha-webhook-secret";
const BETA_WEBHOOK = "beta-webhook-secret";

function fakeExtractor() {
  const state = {
    calls: [],
    searches: [],
    healthy: true,
    fail: false,
  };
  return {
    state,
    async extract(input) {
      state.calls.push(input);
      if (state.fail) {
        throw new Error("extractor is down");
      }
      const text = `Quarterly report for ${input.filename}. Revenue grew in the alpha segment.`;
      return {
        text,
        pageCount: 1,
        charCount: text.length,
        embeddingModel: "hash-384",
        chunks: [
          { seq: 0, text: "Quarterly report. Revenue grew.", embedding: [0.8, 0.2, 0] },
          { seq: 1, text: "The alpha segment expanded.", embedding: [0.1, 0.9, 0] },
        ],
        metadata: {},
      };
    },
    async search({ query, chunks, limit }) {
      state.searches.push({ query, count: chunks.length });
      const lowered = query.toLowerCase();
      return {
        model: "hash-384",
        dimensions: 3,
        results: chunks
          .map((chunk) => ({
            id: chunk.id,
            score: chunk.text.toLowerCase().includes(lowered) ? 0.92 : 0.31,
          }))
          .sort((left, right) => right.score - left.score)
          .slice(0, limit),
      };
    },
    async health() {
      if (!state.healthy) {
        throw new Error("unreachable");
      }
      return { status: "ok", embeddingBackend: "hash-384", dimensions: 3 };
    },
  };
}

function testConfig(root) {
  return {
    nodeEnv: "test",
    logLevel: "silent",
    dataDir: root,
    uploadDir: path.join(root, "uploads"),
    exportDir: path.join(root, "exports"),
    maxUploadBytes: 1024 * 1024,
    maxChunksPerSearch: 100,
    maxSearchLimit: 50,
    jobMaxAttempts: 2,
    jobPollMs: 60_000,
    cronEnabled: false,
    exportRetentionDays: 7,
    s3: { bucket: null, region: "us-east-1", prefix: "test", endpoint: null },
    corsOrigin: false,
    tenants: [
      {
        id: "alpha",
        name: "Alpha",
        apiKey: ALPHA_KEY,
        webhookSecret: ALPHA_WEBHOOK,
      },
      {
        id: "beta",
        name: "Beta",
        apiKey: BETA_KEY,
        webhookSecret: BETA_WEBHOOK,
      },
    ],
  };
}

async function makeContext() {
  const root = await mkdtemp(path.join(os.tmpdir(), "doc-gateway-"));
  const config = testConfig(root);
  const db = new DatabaseSync(":memory:");
  const store = new Store(db);
  const extractor = fakeExtractor();
  const exporter = createExportService({ config, store, logger: silentLogger() });
  const jobs = new JobRunner({
    store,
    extractor,
    logger: silentLogger(),
    maxAttempts: config.jobMaxAttempts,
    pollMs: config.jobPollMs,
  });
  const app = await buildApp({
    config,
    store,
    extractor,
    jobs,
    exporter,
    logger: false,
    enableRateLimit: false,
  });
  await app.ready();
  return { app, store, extractor, jobs, config, db, root };
}

function silentLogger() {
  return { info() {}, warn() {}, error() {}, debug() {} };
}

async function cleanup(context) {
  await context.app.close();
  context.db.close();
  await rm(context.root, { recursive: true, force: true });
}

function multipartFile({ filename = "note.txt", content = "Alpha revenue report", type = "text/plain" }) {
  const boundary = `----doc-test-${randomBytes(8).toString("hex")}`;
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`,
    ),
    Buffer.from(content),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return {
    body,
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

async function upload(context, { key = ALPHA_KEY, filename = "note.txt", content } = {}) {
  const form = multipartFile({ filename, content });
  return context.app.inject({
    method: "POST",
    url: "/v1/documents",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": form.contentType,
    },
    payload: form.body,
  });
}

function sign(secret, rawBody) {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

describe("document gateway", () => {
  it("rejects missing or wrong API keys", async () => {
    const context = await makeContext();
    try {
      assert.equal((await context.app.inject({ method: "GET", url: "/v1/documents" })).statusCode, 401);
      const wrong = await context.app.inject({
        method: "GET",
        url: "/v1/documents",
        headers: { authorization: "Bearer nope" },
      });
      assert.equal(wrong.statusCode, 401);
      const ok = await context.app.inject({
        method: "GET",
        url: "/v1/documents",
        headers: { authorization: `Bearer ${ALPHA_KEY}` },
      });
      assert.equal(ok.statusCode, 200);
      assert.equal(ok.json().documents.length, 0);
    } finally {
      await cleanup(context);
    }
  });

  it("uploads a document, extracts it through the service and serves its text", async () => {
    const context = await makeContext();
    try {
      const response = await upload(context);
      assert.equal(response.statusCode, 202);
      const document = response.json().document;
      assert.equal(document.status, "pending");
      assert.equal(document.filename, "note.txt");

      const processed = await context.jobs.runOnce();
      assert.equal(processed, 1);

      const detail = await context.app.inject({
        method: "GET",
        url: `/v1/documents/${document.id}`,
        headers: { authorization: `Bearer ${ALPHA_KEY}` },
      });
      assert.equal(detail.statusCode, 200);
      assert.equal(detail.json().document.status, "ready");
      assert.equal(detail.json().document.pageCount, 1);
      assert.equal(detail.json().document.charCount > 10, true);

      const text = await context.app.inject({
        method: "GET",
        url: `/v1/documents/${document.id}/text`,
        headers: { authorization: `Bearer ${ALPHA_KEY}` },
      });
      assert.equal(text.statusCode, 200);
      assert.match(text.json().text, /Revenue grew/);
      assert.equal(text.json().chunks.length, 2);
      assert.equal(context.extractor.state.calls.length, 1);
      assert.match(context.extractor.state.calls[0].filePath, /note\.txt$/);
    } finally {
      await cleanup(context);
    }
  });

  it("keeps documents isolated between tenants and rejects unsupported files", async () => {
    const context = await makeContext();
    try {
      const response = await upload(context);
      const id = response.json().document.id;
      await context.jobs.runOnce();

      const beta = await context.app.inject({
        method: "GET",
        url: `/v1/documents/${id}/text`,
        headers: { authorization: `Bearer ${BETA_KEY}` },
      });
      assert.equal(beta.statusCode, 404);

      const deleteBeta = await context.app.inject({
        method: "DELETE",
        url: `/v1/documents/${id}`,
        headers: { authorization: `Bearer ${BETA_KEY}` },
      });
      assert.equal(deleteBeta.statusCode, 404);

      const unsupported = await upload(context, { filename: "payload.exe" });
      assert.equal(unsupported.statusCode, 415);
      assert.equal(unsupported.json().error, "unsupported_file_type");
    } finally {
      await cleanup(context);
    }
  });

  it("proxies vector search and filters by document", async () => {
    const context = await makeContext();
    try {
      const uploaded = await upload(context);
      const id = uploaded.json().document.id;
      await context.jobs.runOnce();

      const search = await context.app.inject({
        method: "POST",
        url: "/v1/search",
        headers: { authorization: `Bearer ${ALPHA_KEY}` },
        payload: { query: "alpha", limit: 2 },
      });
      assert.equal(search.statusCode, 200);
      assert.equal(search.json().scannedChunks, 2);
      assert.equal(search.json().results.length, 2);
      assert.equal(search.json().results[0].score, 0.92);
      assert.equal(context.extractor.state.searches.length, 1);

      const filtered = await context.app.inject({
        method: "POST",
        url: "/v1/search",
        headers: { authorization: `Bearer ${ALPHA_KEY}` },
        payload: { query: "alpha", documentId: id, limit: 5 },
      });
      assert.equal(filtered.statusCode, 200);
      assert.equal(filtered.json().scannedChunks, 2);

      const missing = await context.app.inject({
        method: "POST",
        url: "/v1/search",
        headers: { authorization: `Bearer ${BETA_KEY}` },
        payload: { query: "alpha", documentId: id },
      });
      assert.equal(missing.statusCode, 404);
    } finally {
      await cleanup(context);
    }
  });

  it("verifies CRM webhook signatures and requeues documents", async () => {
    const context = await makeContext();
    try {
      const uploaded = await upload(context);
      const id = uploaded.json().document.id;
      await context.jobs.runOnce();

      const payload = JSON.stringify({ type: "document.ready", documentId: id, crm: "hubspot" });
      const valid = await context.app.inject({
        method: "POST",
        url: "/webhooks/crm/hubspot",
        headers: {
          "content-type": "application/json",
          "x-tenant-id": "alpha",
          "x-crm-event": "document.ready",
          "x-crm-signature": sign(ALPHA_WEBHOOK, Buffer.from(payload)),
        },
        payload,
      });
      assert.equal(valid.statusCode, 202);
      assert.equal(valid.json().queued, true);

      const invalid = await context.app.inject({
        method: "POST",
        url: "/webhooks/crm/hubspot",
        headers: {
          "content-type": "application/json",
          "x-tenant-id": "alpha",
          "x-crm-signature": sign(BETA_WEBHOOK, Buffer.from(payload)),
        },
        payload,
      });
      assert.equal(invalid.statusCode, 401);

      const events = await context.app.inject({
        method: "GET",
        url: "/v1/webhooks",
        headers: { authorization: `Bearer ${ALPHA_KEY}` },
      });
      assert.equal(events.statusCode, 200);
      assert.equal(events.json().events.length, 1);
      assert.equal(events.json().events[0].eventType, "document.ready");

      const betaEvents = await context.app.inject({
        method: "GET",
        url: "/v1/webhooks",
        headers: { authorization: `Bearer ${BETA_KEY}` },
      });
      assert.equal(betaEvents.json().events.length, 0);
    } finally {
      await cleanup(context);
    }
  });

  it("exports tenant data to local JSONL and downloads it", async () => {
    const context = await makeContext();
    try {
      await upload(context);
      await context.jobs.runOnce();

      const created = await context.app.inject({
        method: "POST",
        url: "/v1/exports",
        headers: { authorization: `Bearer ${ALPHA_KEY}` },
        payload: { includeText: true, includeEmbeddings: false },
      });
      assert.equal(created.statusCode, 201);
      const record = created.json().export;
      assert.equal(record.status, "ready");
      assert.equal(record.localPath, undefined);
      assert.equal(record.bytes > 0, true);

      const download = await context.app.inject({
        method: "GET",
        url: `/v1/exports/${record.id}/download`,
        headers: { authorization: `Bearer ${ALPHA_KEY}` },
      });
      assert.equal(download.statusCode, 200);
      assert.match(download.body, /"type":"document"/);
      assert.match(download.body, /"type":"chunk"/);

      const betaDownload = await context.app.inject({
        method: "GET",
        url: `/v1/exports/${record.id}/download`,
        headers: { authorization: `Bearer ${BETA_KEY}` },
      });
      assert.equal(betaDownload.statusCode, 404);
    } finally {
      await cleanup(context);
    }
  });

  it("reports health and records extraction failures", async () => {
    const context = await makeContext();
    try {
      const healthy = await context.app.inject({ method: "GET", url: "/healthz" });
      assert.equal(healthy.statusCode, 200);
      assert.equal(healthy.json().extractor.status, "ok");

      context.extractor.state.healthy = false;
      const degraded = await context.app.inject({ method: "GET", url: "/healthz" });
      assert.equal(degraded.statusCode, 503);

      context.extractor.state.fail = true;
      const uploaded = await upload(context);
      await context.jobs.runOnce();
      const detail = await context.app.inject({
        method: "GET",
        url: `/v1/documents/${uploaded.json().document.id}`,
        headers: { authorization: `Bearer ${ALPHA_KEY}` },
      });
      assert.equal(detail.json().document.status, "pending");
      assert.match(detail.json().document.error, /extractor is down/);

      const stats = await context.app.inject({
        method: "GET",
        url: "/v1/tenants/me",
        headers: { authorization: `Bearer ${ALPHA_KEY}` },
      });
      assert.equal(stats.statusCode, 200);
      assert.equal(stats.json().tenant.id, "alpha");
      assert.equal(stats.json().stats.documents, 1);
    } finally {
      await cleanup(context);
    }
  });
});
