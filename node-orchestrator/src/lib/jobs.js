export class JobRunner {
  constructor({ store, extractor, logger, maxAttempts = 3, pollMs = 1000 }) {
    this.store = store;
    this.extractor = extractor;
    this.logger = logger;
    this.maxAttempts = maxAttempts;
    this.pollMs = pollMs;
    this.timer = null;
    this.busy = false;
  }

  start() {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.#tick();
    }, this.pollMs);
    this.timer.unref?.();
    void this.#tick();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  kick() {
    setImmediate(() => {
      void this.#tick();
    });
  }

  async #tick() {
    if (this.busy) {
      return;
    }
    this.busy = true;
    try {
      await this.runOnce();
    } catch (error) {
      this.logger.error({ err: error }, "job runner tick failed");
    } finally {
      this.busy = false;
    }
  }

  async runOnce(limit = 5) {
    let processed = 0;
    for (let index = 0; index < limit; index += 1) {
      const job = this.store.claimNextJob();
      if (!job) {
        break;
      }
      await this.#process(job);
      processed += 1;
    }
    return processed;
  }

  async #process(job) {
    const document = this.store.getDocument(job.tenantId, job.documentId);
    if (!document) {
      this.store.failJob(job.id, "document no longer exists");
      return;
    }
    this.store.setDocumentProcessing(job.tenantId, job.documentId);

    try {
      const result = await this.extractor.extract({
        tenantId: job.tenantId,
        documentId: job.documentId,
        filePath: document.localPath,
        filename: document.filename,
        contentType: document.contentType,
      });
      this.store.replaceChunks(job.tenantId, job.documentId, result.chunks, result.embeddingModel);
      this.store.setDocumentReady(job.tenantId, job.documentId, {
        text: result.text,
        pageCount: result.pageCount,
        charCount: result.charCount,
      });
      this.store.completeJob(job.id);
      this.logger.info(
        {
          tenantId: job.tenantId,
          documentId: job.documentId,
          chunks: result.chunks.length,
          model: result.embeddingModel,
        },
        "document extraction finished",
      );
    } catch (error) {
      const message = error.message ?? String(error);
      if (job.attempts >= this.maxAttempts) {
        this.store.failJob(job.id, message);
        this.store.setDocumentFailed(job.tenantId, job.documentId, message);
        this.logger.warn(
          { tenantId: job.tenantId, documentId: job.documentId, attempts: job.attempts, err: error },
          "document extraction failed permanently",
        );
        return;
      }
      const delayMs = Math.min(60_000, 1000 * 2 ** Math.max(0, job.attempts - 1));
      this.store.retryJob(job.id, message, delayMs);
      this.store.setDocumentPending(job.tenantId, job.documentId, message);
      this.logger.warn(
        {
          tenantId: job.tenantId,
          documentId: job.documentId,
          attempts: job.attempts,
          retryInMs: delayMs,
          err: error,
        },
        "document extraction will be retried",
      );
    }
  }
}
