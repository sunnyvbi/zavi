
import { tenantClient, asTenantId } from "@/services/tenant-client";

export type UrlGroundingSources = {
  productHosts: readonly string[];
  userTexts: readonly string[];
};

export function productUrlToHosts(raw: unknown): string[] {
  const out = new Set<string>();
  const add = (v: unknown) => {
    if (typeof v !== "string") return;
    const h = hostOf(v);
    if (h) out.add(h);
  };
  if (typeof raw === "string") {
    add(raw);
  } else if (raw && typeof raw === "object") {
    for (const v of Object.values(raw as Record<string, unknown>)) add(v);
  }
  return [...out];
}

export function hostOf(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    const host = u.hostname.toLowerCase();
    return host.startsWith("www.") ? host.slice(4) : host;
  } catch {
    return null;
  }
}

function isSameSite(host: string, base: string): boolean {
  return host === base || host.endsWith(`.${base}`);
}

function mentionedByUser(host: string, userTexts: readonly string[]): boolean {
  const needle = host.toLowerCase();
  return userTexts.some((t) => t.toLowerCase().includes(needle));
}

export function ungroundedHosts(urls: readonly string[], sources: UrlGroundingSources): string[] {
  const bases = sources.productHosts;
  const bad = new Set<string>();
  for (const raw of urls) {
    const host = typeof raw === "string" ? hostOf(raw) : null;
    if (!host) {
      bad.add((typeof raw === "string" && raw.trim()) || "(unparseable)");
      continue;
    }
    if (bases.some((b) => isSameSite(host, b))) continue;
    if (mentionedByUser(host, sources.userTexts)) continue;
    bad.add(host);
  }
  return [...bad];
}

export async function loadUrlGroundingSources(args: {
  tenant_id: string;
  chat_thread_id?: string;
  slack_thread_ts?: string;
}): Promise<UrlGroundingSources> {
  const tc = tenantClient(asTenantId(args.tenant_id));

  const { data: tenantRow, error: tErr } = await tc
    .from("tenants")
    .select("product_url")
    .maybeSingle<{ product_url: unknown }>();
  if (tErr) throw new Error(`url-grounding: tenants read failed: ${tErr.message}`);

  const userTexts: string[] = [];

  if (args.chat_thread_id) {
    const { data, error } = await tc
      .from("agent_thread_messages")
      .select("body")
      .eq("thread_id", args.chat_thread_id)
      .eq("sender_role", "user");
    if (error) throw new Error(`url-grounding: thread messages read failed: ${error.message}`);
    for (const row of (data ?? []) as { body: string | null }[]) {
      if (row.body) userTexts.push(row.body);
    }
  }

  if (args.slack_thread_ts) {
    const { data, error } = await tc
      .from("agent_runs")
      .select("payload")
      .eq("trigger", "slack")
      .filter("payload->slack->>thread_ts", "eq", args.slack_thread_ts);
    if (error) throw new Error(`url-grounding: slack turns read failed: ${error.message}`);
    for (const row of (data ?? []) as { payload: { slack?: { text?: string } } | null }[]) {
      const text = row.payload?.slack?.text;
      if (text) userTexts.push(text);
    }
  }

  return { productHosts: productUrlToHosts(tenantRow?.product_url), userTexts };
}
