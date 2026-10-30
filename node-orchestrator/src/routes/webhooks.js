import { verifyWebhookSignature } from "../auth.js";

const providerParams = {
  type: "object",
  required: ["provider"],
  properties: {
    provider: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{1,63}$" },
  },
};

export async function webhookRoutes(app, { store, jobs, authenticate }) {
  app.post(
    "/webhooks/crm/:provider",
    {
      schema: { params: providerParams },
      config: {
        rateLimit: {
          max: 120,
          timeWindow: "1 minute",
          keyGenerator: (request) => request.ip,
        },
      },
    },
    async (request, reply) => {
      const tenantId = String(request.headers["x-tenant-id"] ?? "").trim();
      const tenant = tenantId ? store.getTenant(tenantId) : null;
      const signature = request.headers["x-crm-signature"];
      if (!tenant || !verifyWebhookSignature(tenant.webhookSecret, request.rawBody, signature)) {
        request.log.warn({ tenantId, provider: request.params.provider }, "rejected crm webhook");
        return reply.code(401).send({ error: "invalid_signature" });
      }

      const body = request.body;
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return reply.code(400).send({ error: "invalid_payload" });
      }

      const eventType = String(
        request.headers["x-crm-event"] ?? body.type ?? body.event ?? "unknown",
      ).slice(0, 120);
      const eventId = store.addWebhookEvent({
        tenantId,
        provider: request.params.provider,
        eventType,
        payload: body,
      });

      let queued = false;
      const documentId = typeof body.documentId === "string" ? body.documentId : null;
      if (
        documentId &&
        ["document.ready", "document.updated", "reindex.requested"].includes(eventType)
      ) {
        const document = store.getDocument(tenantId, documentId);
        if (document && document.status !== "processing") {
          store.enqueueJob(tenantId, documentId);
          jobs.kick();
          queued = true;
        }
      }

      return reply.code(202).send({ eventId, received: true, queued });
    },
  );

  app.get("/v1/webhooks", { preHandler: authenticate }, async (request) => ({
    events: store.listWebhookEvents(request.tenant.id),
  }));
}
