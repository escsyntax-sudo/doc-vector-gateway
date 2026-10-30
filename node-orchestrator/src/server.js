import { DatabaseSync } from "node:sqlite";

import { buildApp } from "./app.js";
import { config } from "./config.js";
import { Store } from "./db.js";
import { createExportService } from "./lib/exporter.js";
import { createExtractorClient } from "./lib/extractor.js";
import { JobRunner } from "./lib/jobs.js";
import { createScheduler } from "./lib/scheduler.js";

async function main() {
  const db = new DatabaseSync(config.dbPath);
  const store = new Store(db);
  const extractor = createExtractorClient({
    baseUrl: config.extractorUrl,
    token: config.internalToken,
  });
  const exporter = createExportService({ config, store, logger: console });
  const jobs = new JobRunner({
    store,
    extractor,
    logger: console,
    maxAttempts: config.jobMaxAttempts,
    pollMs: config.jobPollMs,
  });

  const app = await buildApp({ config, store, extractor, jobs, exporter });
  const scheduler = createScheduler({
    store,
    jobs,
    exporter,
    logger: app.log,
    config,
  });

  app.addHook("onClose", async () => {
    jobs.stop();
    scheduler.stop();
    db.close();
  });

  await app.listen({ port: config.port, host: config.host });
  jobs.start();
  scheduler.start();
  app.log.info(
    {
      port: config.port,
      extractor: config.extractorUrl,
      s3: Boolean(config.s3.bucket),
    },
    "document gateway listening",
  );

  const shutdown = async (signal) => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
