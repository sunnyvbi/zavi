
type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ status: number; json: () => Promise<unknown>; text: () => Promise<string> }>;

export type CloudflareDnsDeps = {
  token?: () => string | null;
  zoneId?: () => string | null;
  fetchFn?: FetchLike;
};

const CF = "https://api.cloudflare.com/client/v4";

function cfHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

type CfEnvelope<T> = {
  success?: boolean;
  result?: T;
  errors?: Array<{ code?: number; message?: string }>;
};

type CfDnsRecord = { id?: string; name?: string; type?: string; content?: string };

function cfErrText(env: CfEnvelope<unknown>): string {
  const errs = env.errors ?? [];
  return errs.length ? errs.map((e) => `${e.code ?? "?"}:${e.message ?? ""}`).join("; ") : "unknown cloudflare error";
}

function resolveDeps(deps: CloudflareDnsDeps): {
  token: string | null;
  zoneId: string | null;
  fetchFn: FetchLike;
} {
  const token = (deps.token ?? (() => process.env.CLOUDFLARE_API_TOKEN ?? null))();
  const zoneId = (deps.zoneId ?? (() => process.env.CLOUDFLARE_ZONE_ID ?? null))();
  const fetchFn = deps.fetchFn ?? ((globalThis as { fetch: FetchLike }).fetch);
  return { token, zoneId, fetchFn };
}

async function findCname(
  fetchFn: FetchLike,
  token: string,
  zoneId: string,
  name: string,
): Promise<CfDnsRecord | null> {
  const url = `${CF}/zones/${zoneId}/dns_records?type=CNAME&name=${encodeURIComponent(name)}`;
  const res = await fetchFn(url, { headers: cfHeaders(token) });
  const env = (await res.json()) as CfEnvelope<CfDnsRecord[]>;
  if (res.status < 200 || res.status >= 300 || env.success === false) {
    throw new Error(`cloudflare dns list failed (${res.status}): ${cfErrText(env)}`);
  }
  const arr = env.result ?? [];
  return (
    arr.find(
      (r) =>
        (r.name ?? "").toLowerCase() === name.toLowerCase() &&
        (r.type ?? "").toUpperCase() === "CNAME",
    ) ?? null
  );
}

export const BUILTIN_HOST_IN_USE = "that domain is already in use by another app";

export async function ensureDnsCname(
  name: string,
  target: string,
  deps: CloudflareDnsDeps = {},
  proxied = false,
  opts: { onlyReplaceOnrender?: boolean } = {},
): Promise<{ record_id: string | null; skipped?: boolean }> {
  const { token, zoneId, fetchFn } = resolveDeps(deps);
  if (!token || !zoneId) {
    // eslint-disable-next-line no-console
    console.log(`[cloudflare-dns] skipped CNAME ${name} → ${target}: CLOUDFLARE_API_TOKEN/CLOUDFLARE_ZONE_ID not configured`);
    return { record_id: null, skipped: true };
  }

  const existing = await findCname(fetchFn, token, zoneId, name);
  if (existing?.id) {
    if (existing.content === target) {
      return { record_id: existing.id };
    }
    if (opts.onlyReplaceOnrender && !String(existing.content ?? "").toLowerCase().endsWith(".onrender.com")) {
      throw new Error(BUILTIN_HOST_IN_USE);
    }
    const res = await fetchFn(`${CF}/zones/${zoneId}/dns_records/${existing.id}`, {
      method: "PATCH",
      headers: cfHeaders(token),
      body: JSON.stringify({ type: "CNAME", name, content: target, ttl: 300, proxied }),
    });
    const env = (await res.json()) as CfEnvelope<CfDnsRecord>;
    if (res.status < 200 || res.status >= 300 || env.success === false) {
      throw new Error(`cloudflare dns update failed (${res.status}): ${cfErrText(env)}`);
    }
    return { record_id: env.result?.id ?? existing.id };
  }

  const res = await fetchFn(`${CF}/zones/${zoneId}/dns_records`, {
    method: "POST",
    headers: cfHeaders(token),
    body: JSON.stringify({ type: "CNAME", name, content: target, ttl: 300, proxied }),
  });
  const env = (await res.json()) as CfEnvelope<CfDnsRecord>;
  if (res.status < 200 || res.status >= 300 || env.success === false) {
    throw new Error(`cloudflare dns create failed (${res.status}): ${cfErrText(env)}`);
  }
  return { record_id: env.result?.id ?? null };
}

export async function deleteDnsCname(
  name: string,
  deps: CloudflareDnsDeps = {},
  opts: { onlyOnrender?: boolean } = {},
): Promise<void> {
  const { token, zoneId, fetchFn } = resolveDeps(deps);
  if (!token || !zoneId) return;

  let existing: CfDnsRecord | null = null;
  try {
    existing = await findCname(fetchFn, token, zoneId, name);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[cloudflare-dns] teardown lookup failed for ${name}: ${(e as Error).message}`);
    return;
  }
  if (!existing?.id) return;
  if (opts.onlyOnrender && !String(existing.content ?? "").toLowerCase().endsWith(".onrender.com")) {
    // eslint-disable-next-line no-console
    console.warn(`[cloudflare-dns] refused teardown of ${name}: not an app-host CNAME`);
    return;
  }

  try {
    const res = await fetchFn(`${CF}/zones/${zoneId}/dns_records/${existing.id}`, {
      method: "DELETE",
      headers: cfHeaders(token),
    });
    if (res.status === 404) return;
    if (res.status < 200 || res.status >= 300) {
      const env = (await res.json().catch(() => ({}))) as CfEnvelope<unknown>;
      // eslint-disable-next-line no-console
      console.warn(`[cloudflare-dns] teardown delete failed (${res.status}) for ${name}: ${cfErrText(env)}`);
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[cloudflare-dns] teardown delete threw for ${name}: ${(e as Error).message}`);
  }
}
