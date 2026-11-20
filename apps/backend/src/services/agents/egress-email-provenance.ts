
const LOCAL_CHAR = /[A-Za-z0-9._%+-]/;
const DOMAIN_CHAR = /[A-Za-z0-9.-]/;
const ALPHA = /[A-Za-z]/;

export function emailSpans(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  if (!text) return out;
  let floor = 0;
  for (let at = text.indexOf("@"); at !== -1; at = text.indexOf("@", at + 1)) {
    if (at < floor) continue;
    let start = at;
    while (start > floor && LOCAL_CHAR.test(text[start - 1])) start--;
    if (start === at) continue;
    let run = at + 1;
    while (run < text.length && DOMAIN_CHAR.test(text[run])) run++;
    let end = -1;
    for (let dot = run - 1; dot >= at + 2; dot--) {
      if (text[dot] !== ".") continue;
      let l = dot + 1;
      while (l < text.length && ALPHA.test(text[l])) l++;
      if (l - dot - 1 >= 2) {
        end = l;
        break;
      }
    }
    if (end === -1) continue;
    out.push([start, end]);
    floor = end;
  }
  return out;
}

export function replaceEmails(text: string, fn: (address: string) => string): string {
  const spans = emailSpans(text);
  if (spans.length === 0) return text;
  let out = "";
  let last = 0;
  for (const [a, b] of spans) {
    out += text.slice(last, a) + fn(text.slice(a, b));
    last = b;
  }
  return out + text.slice(last);
}

export const ENCODED_EMAIL_RE = /(?<![A-Za-z0-9._%+-])(?:[A-Za-z0-9._+-]|%[0-9A-Fa-f]{2}){1,256}%40[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}/gi;
export const OBFUSCATED_EMAIL_RE =
  /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,256}\s{0,20}[[({]\s{0,20}at\s{0,20}[\])}]\s{0,20}[A-Za-z0-9-]{1,63}(?:\s{0,20}(?:\.|[[({]\s{0,20}dot\s{0,20}[\])}])\s{0,20}[A-Za-z0-9-]{1,63}){0,8}/gi;

export function emailsIn(text: string): string[] {
  return emailSpans(text).map(([a, b]) => text.slice(a, b).toLowerCase());
}

const EMAIL_ALLOWANCE_AGENTS: ReadonlySet<string> = new Set(["cgo", "email_marketing"]);

const SENDER_ALLOWANCE_AGENT = "email_marketing";

type ReadTenantSender = (tenantId: string) => Promise<{ from_address?: unknown } | null>;

const readVerifiedBulkSender: ReadTenantSender = async (tenantId) =>
  (await import("@/services/comms/bulk-outbound/sending-domain")).resolveBulkSender(tenantId);

export async function runEmailAllowlist(
  agentSlug: string | undefined,
  tenantId: string | undefined,
  ownerList: string[],
  readSender: ReadTenantSender = readVerifiedBulkSender,
): Promise<string[]> {
  if (agentSlug !== SENDER_ALLOWANCE_AGENT) return ownerList;
  if (!tenantId) return [];
  try {
    const sender = await readSender(tenantId);
    const from = sender?.from_address;
    return typeof from === "string" && isOneEmail(from.trim()) ? [from.trim().toLowerCase()] : [];
  } catch {
    return [];
  }
}

export function keptEmailsFor(agentSlug: string | undefined, list: unknown): ReadonlySet<string> | undefined {
  if (!agentSlug || !EMAIL_ALLOWANCE_AGENTS.has(agentSlug) || !Array.isArray(list)) return undefined;
  if (!list.every((e) => typeof e === "string" && isOneEmail(e))) return undefined;
  return new Set((list as string[]).map((e) => e.toLowerCase()));
}

function isOneEmail(e: string): boolean {
  const spans = emailSpans(e);
  return spans.length === 1 && spans[0][0] === 0 && spans[0][1] === e.length;
}
