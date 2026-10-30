import { schedule } from "node-cron";

export function createScheduler({ store, jobs, exporter, logger, config }) {
  const tasks = [];

  async function retryWork() {
    const stale = store.requeueStaleJobs(Date.now() - 15 * 60 * 1000);
    const failed = store.requeueFailedJobs(config.jobMaxAttempts);
    if (stale > 0 || failed > 0) {
      logger.info({ stale, failed }, "cron requeued extraction jobs");
      jobs.kick();
    }
  }

  async function cleanup() {
    const removed = await exporter.cleanupOld();
    if (removed > 0) {
      logger.info({ removed }, "cron removed expired exports");
    }
  }

  return {
    start() {
      if (tasks.length > 0 || !config.cronEnabled) {
        return;
      }
      tasks.push(
        schedule("*/5 * * * *", retryWork, {
          name: "doc-retry-jobs",
          noOverlap: true,
        }),
      );
      tasks.push(
        schedule("0 3 * * *", cleanup, {
          name: "doc-cleanup-exports",
          noOverlap: true,
        }),
      );
      logger.info("cron scheduler started");
    },
    stop() {
      for (const task of tasks) {
        task.destroy();
      }
      tasks.length = 0;
    },
    retryWork,
    cleanup,
  };
}
