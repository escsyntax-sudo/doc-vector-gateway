import fs from "node:fs";
import path from "node:path";

function readInt(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readBool(value, fallback) {
  if (value === undefined) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function developmentTenants() {
  return [
    {
      id: "demo",
      name: "Demo tenant",
      apiKey: "demo-key",
      webhookSecret: "demo-webhook-secret",
    },
  ];
}

function parseTenants(raw) {
  if (!raw) {
    return developmentTenants();
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("DOC_TENANTS must be valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("DOC_TENANTS must be a non-empty array");
  }
  const seen = new Set();
  return parsed.map((item, index) => {
    const id = String(item?.id ?? "").trim();
    const name = String(item?.name ?? id).trim();
    const apiKey = String(item?.apiKey ?? "").trim();
    const webhookSecret = String(item?.webhookSecret ?? "").trim();
    if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(id)) {
      throw new Error(`tenant at index ${index} has an invalid id`);
    }
    if (seen.has(id)) {
      throw new Error(`duplicate tenant id: ${id}`);
    }
    if (apiKey.length < 12) {
      throw new Error(`tenant ${id} needs an apiKey of at least 12 characters`);
    }
    if (webhookSecret.length < 12) {
      throw new Error(`tenant ${id} needs a webhookSecret of at least 12 characters`);
    }
    seen.add(id);
    return { id, name, apiKey, webhookSecret };
  });
}

const dataDir = path.resolve(process.env.DOC_DATA_DIR ?? "./data");
const nodeEnv = process.env.NODE_ENV ?? "development";
const tenants = parseTenants(process.env.DOC_TENANTS ?? "");

if (nodeEnv === "production" && !process.env.DOC_TENANTS) {
  throw new Error("DOC_TENANTS must be set when NODE_ENV=production");
}
if (nodeEnv === "production" && !process.env.DOC_INTERNAL_TOKEN) {
  throw new Error("DOC_INTERNAL_TOKEN must be set when NODE_ENV=production");
}

export const config = {
  nodeEnv,
  port: readInt(process.env.PORT, 8080),
  host: process.env.HOST ?? "0.0.0.0",
  logLevel: process.env.LOG_LEVEL ?? "info",
  dataDir,
  dbPath: process.env.DOC_DB_PATH ?? path.join(dataDir, "doc-vectors.db"),
  uploadDir: path.join(dataDir, "uploads"),
  exportDir: path.join(dataDir, "exports"),
  extractorUrl: (process.env.DOC_EXTRACTOR_URL ?? "http://127.0.0.1:8000").replace(/\/+$/, ""),
  internalToken: process.env.DOC_INTERNAL_TOKEN ?? "dev-internal-token",
  maxUploadBytes: readInt(process.env.DOC_MAX_UPLOAD_BYTES, 20 * 1024 * 1024),
  maxChunksPerSearch: readInt(process.env.DOC_MAX_SEARCH_CHUNKS, 5000),
  maxSearchLimit: readInt(process.env.DOC_MAX_SEARCH_LIMIT, 50),
  jobPollMs: readInt(process.env.DOC_JOB_POLL_MS, 1000),
  jobMaxAttempts: readInt(process.env.DOC_JOB_MAX_ATTEMPTS, 3),
  cronEnabled: readBool(process.env.DOC_CRON_ENABLED, true),
  exportRetentionDays: readInt(process.env.DOC_EXPORT_RETENTION_DAYS, 7),
  corsOrigin: process.env.CORS_ORIGIN?.trim() ? process.env.CORS_ORIGIN : false,
  s3: {
    bucket: process.env.DOC_S3_BUCKET?.trim() || null,
    region: process.env.DOC_S3_REGION?.trim() || "us-east-1",
    prefix: process.env.DOC_S3_PREFIX?.trim() || "doc-vector-exports",
    endpoint: process.env.DOC_S3_ENDPOINT?.trim() || null,
  },
  tenants,
};

fs.mkdirSync(config.uploadDir, { recursive: true });
fs.mkdirSync(config.exportDir, { recursive: true });
fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
