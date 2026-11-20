
const RECEIPT_HOSTS: readonly string[] = ["mailchimp.com", "klaviyo.com", "github.com"];

const MAX_LINE = 200;

export type ExecReceipt = { line: string; url?: string };

function safeUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 500) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password) return null;
  const host = u.hostname.toLowerCase();
  return RECEIPT_HOSTS.some((h) => host === h || host.endsWith(`.${h}`)) ? u.toString() : null;
}

export function safeExecReceipt(raw: unknown): ExecReceipt | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as { line?: unknown; url?: unknown };
  const line = typeof r.line === "string" ? r.line.replace(/\s+/g, " ").trim().slice(0, MAX_LINE) : "";
  if (!line) return null;
  const url = safeUrl(r.url);
  return url ? { line, url } : { line };
}

export function actionExecReceipt(execClass: unknown, result: unknown): ExecReceipt | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const raw = result as { receipt?: unknown; created?: unknown };
  const receipt = safeExecReceipt(raw.receipt);
  if (receipt || execClass !== "chatgpt_ads.create_and_launch") return receipt;
  if (!raw.created || typeof raw.created !== "object" || Array.isArray(raw.created)) return null;
  const created = raw.created as { id?: unknown; platform?: unknown; object_type?: unknown; status?: unknown };
  if (created.platform !== "chatgpt" || created.object_type !== "campaign" || typeof created.id !== "string" || !/^(?:cmpn_[a-zA-Z0-9]{1,80}|[a-f0-9-]{36})$/.test(created.id)) return null;
  return safeExecReceipt({ line: `Campaign reference: ${created.id}. This records the completed action; check the campaign list for current delivery.` });
}

