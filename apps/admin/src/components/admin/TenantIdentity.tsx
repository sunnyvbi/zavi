"use client";

export type TenantIdentity = { id: string; slug: string; display_name: string };

export function TenantBackLink({
  tenantId,
  tenant,
}: {
  tenantId: string;
  tenant: TenantIdentity | null;
}) {
  return (
    <a href={`/tenants/${tenantId}`} className="text-sm text-slate-500 hover:underline">
      ← {tenant?.display_name ?? "tenant"}
    </a>
  );
}

export function TenantLabel({
  tenantId,
  tenant,
}: {
  tenantId: string;
  tenant: TenantIdentity | null;
}) {
  const shortId = <span className="font-mono">{tenantId.slice(0, 8)}</span>;
  if (!tenant) return shortId;
  return (
    <>
      <span className="font-medium text-slate-700">{tenant.display_name}</span> · {tenant.slug} ·{" "}
      {shortId}
    </>
  );
}
