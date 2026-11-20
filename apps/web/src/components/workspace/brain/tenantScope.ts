
export function scopeToTenant<T>(query: T, tenantId: string): T {
  return (query as unknown as { eq(column: string, value: string): T }).eq(
    "tenant_id",
    tenantId,
  );
}

export function tenantRealtimeFilter(tenantId: string): string {
  return `tenant_id=eq.${tenantId}`;
}
