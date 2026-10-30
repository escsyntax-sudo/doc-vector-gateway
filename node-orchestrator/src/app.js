import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";

import { buildAuthenticate, seedTenants } from "./auth.js";
import { documentRoutes } from "./routes/documents.js";
import { exportRoutes } from "./routes/exports.js";
import { healthRoutes } from "./routes/health.js";
import { searchRoutes } from "./routes/search.js";
import { tenantRoutes } from "./routes/tenant.js";
import { webhookRoutes } from "./routes/webhooks.js";

export async function buildApp({
  config,
  store,
  extractor,
  jobs,
  exporter,
  logger = true,
  enableRateLimit = true,
}) {
  seedTenants(store, config.tenants);
  const authenticate = buildAuthenticate(store);

  const app = Fastify({
    logger: logger ? { level: config.logLevel } : false,
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  if (config.corsOrigin) {
    await app.register(cors, { origin: config.corsOrigin });
  }
  if (enableRateLimit) {
    await app.register(rateLimit, {
      max: 300,
      timeWindow: "1 minute",
    });
  }
  await app.register(multipart, {
    limits: {
      fileSize: config.maxUploadBytes,
      files: 1,
      fields: 5,
      parts: 10,
    },
  });

  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer", bodyLimit: 1024 * 1024 },
    (request, body, done) => {
      request.rawBody = body;
      if (body.length === 0) {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(body.toString("utf8")));
      } catch (error) {
        error.statusCode = 400;
        error.code = "invalid_json";
        done(error);
      }
    },
  );

  app.decorate("store", store);
  app.decorate("authenticate", authenticate);
  app.decorate("jobs", jobs);

  await app.register(healthRoutes, { store, extractor });
  await app.register(tenantRoutes, { store, authenticate });
  await app.register(documentRoutes, { config, store, authenticate, jobs });
  await app.register(searchRoutes, { config, store, extractor, authenticate });
  await app.register(exportRoutes, { store, authenticate, exporter });
  await app.register(webhookRoutes, { store, jobs, authenticate });

  app.setErrorHandler((error, request, reply) => {
    if (error.code === "FST_REQ_FILE_TOO_LARGE") {
      return reply.code(413).send({ error: "file_too_large" });
    }
    if (error.validation) {
      return reply.code(400).send({
        error: "invalid_request",
        details: error.validation.map((item) => ({
          path: item.instancePath || item.params?.missingProperty || "",
          message: item.message,
        })),
      });
    }
    if (error.statusCode && error.statusCode < 500) {
      return reply
        .code(error.statusCode)
        .send({ error: error.code ?? "request_failed", message: error.message });
    }
    request.log.error({ err: error }, "request failed");
    return reply.code(500).send({ error: "internal_error" });
  });

  return app;
}
