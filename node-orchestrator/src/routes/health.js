export async function healthRoutes(app, { store, extractor }) {
  app.get("/healthz", async (request, reply) => {
    let database = "ok";
    try {
      store.db.prepare("SELECT 1 AS ok").get();
    } catch (error) {
      database = "failed";
      request.log.error({ err: error }, "database health check failed");
    }

    let engine = null;
    try {
      engine = await extractor.health();
    } catch (error) {
      request.log.warn({ err: error }, "extractor health check failed");
      engine = { status: "unreachable" };
    }

    const healthy = database === "ok" && engine?.status === "ok";
    return reply.code(healthy ? 200 : 503).send({
      status: healthy ? "ok" : "degraded",
      version: "0.1.0",
      database,
      extractor: engine,
    });
  });
}
