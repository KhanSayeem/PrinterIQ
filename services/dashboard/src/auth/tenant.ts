const defaultTenantId = "10000000-0000-0000-0000-000000000001";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function getDashboardTenantId() {
  const tenantId = process.env.TENANT_ID?.trim();
  if (tenantId) {
    return uuidPattern.test(tenantId) ? tenantId : null;
  }

  return process.env.NODE_ENV === "production" ? null : defaultTenantId;
}

export function requireDashboardTenantId() {
  const tenantId = getDashboardTenantId();
  if (!tenantId) {
    throw new Error("Dashboard tenant not configured");
  }

  return tenantId;
}
