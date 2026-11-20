import { EMAIL_TOOLS, type EmailTool } from "@/services/connectors/email-campaign/providers";
import { liveToolCaller, readToolLists, type ToolCaller } from "@/services/email-test-lists/lists";

export type EmailToolKey = { state: "works" } | { state: "rejected"; sentence: string } | { state: "unknown" };

const UNKNOWN: EmailToolKey = { state: "unknown" };
const POLL_TTL_MS = 60_000;
const POLL_WAIT_MS = 2_500;
const CLICK_WAIT_MS = 5_000;

const reads = new Map<string, { at: number; read: Promise<EmailToolKey> }>();

export function emailToolOf(route: unknown): EmailTool | null {
  return (EMAIL_TOOLS as readonly unknown[]).includes(route) ? (route as EmailTool) : null;
}

async function readKey(tenantId: string, tool: EmailTool, caller: ToolCaller): Promise<EmailToolKey> {
  const read = await readToolLists(tenantId, tool, { caller }, () => true);
  if (read.status === "complete" || read.status === "partial") return { state: "works" };
  if (read.status === "unreadable" && read.error && /rejected the key/i.test(read.error)) return { state: "rejected", sentence: read.error };
  return UNKNOWN;
}

function within(read: Promise<EmailToolKey>, ms: number): Promise<EmailToolKey> {
  let timer: ReturnType<typeof setTimeout>;
  const late = new Promise<EmailToolKey>((done) => {
    timer = setTimeout(() => done(UNKNOWN), ms);
  });
  return Promise.race([read, late]).finally(() => clearTimeout(timer));
}

export function emailToolKey(
  tenantId: string,
  tool: EmailTool,
  o: { fresh?: boolean; now?: number; caller?: ToolCaller } = {},
): Promise<EmailToolKey> {
  const now = o.now ?? Date.now();
  const key = `${tenantId}:${tool}`;
  const held = reads.get(key);
  if (!o.fresh && held && now - held.at < POLL_TTL_MS) return within(held.read, POLL_WAIT_MS);
  for (const [k, v] of reads) if (now - v.at >= POLL_TTL_MS) reads.delete(k);
  const read = readKey(tenantId, tool, o.caller ?? liveToolCaller).catch(() => UNKNOWN);
  reads.set(key, { at: now, read });
  return within(read, o.fresh ? CLICK_WAIT_MS : POLL_WAIT_MS);
}

export function forgetEmailToolKeys(): void {
  reads.clear();
}
