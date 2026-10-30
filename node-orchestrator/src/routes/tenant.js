export async function tenantRoutes(app, { store, authenticate }) {
  app.get("/v1/tenants/me", { preHandler: authenticate }, async (request) => {
    return {
      tenant: {
        id: request.tenant.id,
        name: request.tenant.name,
      },
      stats: store.tenantStats(request.tenant.id),
    };
  });
}
