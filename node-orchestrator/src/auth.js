import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export function hashKey(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

export function seedTenants(store, tenants) {
  for (const tenant of tenants) {
    store.upsertTenant({
      id: tenant.id,
      name: tenant.name,
      apiKeyHash: hashKey(tenant.apiKey),
      webhookSecret: tenant.webhookSecret,
    });
  }
}

export function buildAuthenticate(store) {
  return async function authenticate(request, reply) {
    const header = request.headers.authorization ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const tenant = store.findTenantByKeyHash(hashKey(match[1].trim()));
    if (!tenant) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    request.tenant = tenant;
  };
}

export function verifyWebhookSignature(secret, rawBody, header) {
  if (!header || !Buffer.isBuffer(rawBody)) {
    return false;
  }
  const provided = String(header).replace(/^sha256=/i, "").trim();
  if (!/^[a-f0-9]{64}$/i.test(provided)) {
    return false;
  }
  const expected = createHmac("sha256", String(secret))
    .update(rawBody)
    .digest();
  const actual = Buffer.from(provided, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
