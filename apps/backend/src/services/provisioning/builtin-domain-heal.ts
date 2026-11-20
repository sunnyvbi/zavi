import { onrenderHostFromUrl } from "./domain";
import { validateBuiltinLabel } from "./builtin-url";

export type BuiltinDomainRow = {
  tenant_id: string;
  external_ref: Record<string, unknown> | null;
};

export type BuiltinHealDeps = {
  baseDomain: string;
  loadHosting: (tenant_id: string) => Promise<{ serviceId: string | null; url: string | null } | null>;
  ensureCname: (hostname: string, target: string) => Promise<{ record_id: string | null; skipped?: boolean }>;
  renderStatus: (serviceId: string, customDomainIdOrHost: string) => Promise<string | null>;
  requestVerify?: (serviceId: string, customDomainId: string) => Promise<void>;
  save: (tenant_id: string, external_ref: Record<string, unknown>) => Promise<void>;
  now?: () => number;
};

export type BuiltinHealOutcome = "live" | "verifying" | "skipped";

export const BUILTIN_VERIFY_THROTTLE_MS = 60_000;

const lastVerifyRequestAt = new Map<string, number>();

export function resetBuiltinVerifyThrottle(): void {
  lastVerifyRequestAt.clear();
}

export function noteBuiltinVerifyRequested(hostname: string, now = Date.now()): void {
  lastVerifyRequestAt.set(hostname.toLowerCase(), now);
}

export function builtinVerifyDue(hostname: string, now = Date.now()): boolean {
  const last = lastVerifyRequestAt.get(hostname.toLowerCase());
  return last === undefined || now - last >= BUILTIN_VERIFY_THROTTLE_MS;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export async function advanceBuiltinDomain(
  row: BuiltinDomainRow,
  deps: BuiltinHealDeps,
): Promise<BuiltinHealOutcome> {
  const ref = row.external_ref ?? {};
  const hostname = str(ref.hostname).toLowerCase();
  if (!hostname || !hostname.endsWith(`.${deps.baseDomain.toLowerCase()}`)) return "skipped";
  const label = hostname.slice(0, -(deps.baseDomain.length + 1));
  const valid = validateBuiltinLabel(label);
  if (!valid.ok || valid.label !== label) return "skipped";
  const status = str(ref.status);
  if (status && status !== "verifying") return "skipped";
  const now = deps.now?.() ?? Date.now();

  let serviceId = str(ref.render_service_id);
  let dnsRecordId = str(ref.dns_record_id);
  let hosting: Awaited<ReturnType<BuiltinHealDeps["loadHosting"]>> | undefined;
  let wroteDns = false;
  const attachedToOwnService = async (): Promise<boolean> => {
    if (hosting === undefined) hosting = await deps.loadHosting(row.tenant_id).catch(() => null);
    const own = str(hosting?.serviceId);
    if (!own || own !== serviceId) return false;
    return (await deps.renderStatus(own, hostname).catch(() => null)) !== null;
  };
  if (!serviceId || !dnsRecordId) {
    hosting = await deps.loadHosting(row.tenant_id);
    if (!serviceId) serviceId = str(hosting?.serviceId);
    if (!dnsRecordId) {
      const target = onrenderHostFromUrl(hosting?.url);
      if (!target) return "skipped";
      if (!(await attachedToOwnService())) return "skipped";
      const dns = await deps.ensureCname(hostname, target);
      if (!dns.record_id) return "skipped";
      dnsRecordId = dns.record_id;
      wroteDns = true;
    }
  }
  if (!serviceId) return "skipped";
  const customDomainId = str(ref.custom_domain_id);
  if (wroteDns && customDomainId && deps.requestVerify) {
    await deps.requestVerify(serviceId, customDomainId).catch(() => undefined);
    noteBuiltinVerifyRequested(hostname, now);
  }

  let rs = await deps.renderStatus(serviceId, customDomainId || hostname);
  if (rs !== "verified" && !wroteDns && builtinVerifyDue(hostname, now)) {
    noteBuiltinVerifyRequested(hostname, now);
    if (hosting === undefined) hosting = await deps.loadHosting(row.tenant_id).catch(() => null);
    const target = onrenderHostFromUrl(hosting?.url);
    if (target && (await attachedToOwnService())) {
      const dns = await deps.ensureCname(hostname, target).catch(() => null);
      if (dns?.record_id) dnsRecordId = dns.record_id;
    }
    if (customDomainId && deps.requestVerify) {
      await deps.requestVerify(serviceId, customDomainId).catch(() => undefined);
      rs = await deps.renderStatus(serviceId, customDomainId).catch(() => rs);
    }
  }

  const next: BuiltinHealOutcome = rs === "verified" ? "live" : "verifying";
  const nextRef = { ...ref, render_service_id: serviceId, dns_record_id: dnsRecordId, status: next };
  const changed =
    nextRef.status !== ref.status ||
    nextRef.render_service_id !== ref.render_service_id ||
    nextRef.dns_record_id !== ref.dns_record_id;
  if (changed) await deps.save(row.tenant_id, nextRef);
  return next;
}
