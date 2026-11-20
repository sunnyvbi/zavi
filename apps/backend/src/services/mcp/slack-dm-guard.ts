
import { ExpectedToolError } from "@/services/tools/types";

const WINDOW_MS = 60 * 60 * 1000;

const COLD_SETS_PER_RUN = 5;
const COLD_SETS_PER_TENANT_HOUR = 15;

const COLD_MSGS_PER_RECIPIENT_HOUR = 8;

const tenantHits = new Map<string, number[]>();
const recipientHits = new Map<string, number[]>();
const tenantColdSets = new Map<string, Map<string, number>>();
const runColdSets = new Map<string, Set<string>>();

function prune(arr: number[], now: number): number[] {
  const cutoff = now - WINDOW_MS;
  let i = 0;
  while (i < arr.length && arr[i] < cutoff) i++;
  return i > 0 ? arr.slice(i) : arr;
}

function pruneSets(m: Map<string, number>, now: number): void {
  const cutoff = now - WINDOW_MS;
  for (const [k, ts] of m) if (ts < cutoff) m.delete(k);
}

export function recipientKeyFor(userIds: string[]): string {
  return [...userIds].map((u) => u.trim()).filter(Boolean).sort().join(",");
}

export function isConsentedSlackReply(
  ctx: {
    slack_inbound_delivery?: boolean;
    slack_routing?: { channel_id?: string };
  },
  args: unknown,
): boolean {
  if (ctx.slack_inbound_delivery === true) return true;

  const inbound = ctx.slack_routing?.channel_id;
  if (!inbound) return false;
  const a = (args ?? {}) as Record<string, unknown>;
  return typeof a.channel_id === "string" && a.channel_id === inbound;
}

export function assertColdContactWithinCaps(
  tenantId: string,
  runId: string | undefined,
  userIds: string[],
  nowMs: number = Date.now(),
): void {
  const rKey = recipientKeyFor(userIds);

  const runKey = `${tenantId}::${runId || "no-run"}`;
  const runSet = runColdSets.get(runKey) ?? new Set<string>();
  if (!runSet.has(rKey) && runSet.size >= COLD_SETS_PER_RUN) {
    throw new ExpectedToolError(
      "slack_dm_rate_limited",
      `This run has already messaged ${COLD_SETS_PER_RUN} different people/groups who did not contact you. Ask the user before messaging anyone else.`,
      { scope: "run_breadth", limit: COLD_SETS_PER_RUN },
    );
  }

  const tSets = tenantColdSets.get(tenantId) ?? new Map<string, number>();
  pruneSets(tSets, nowMs);
  if (!tSets.has(rKey) && tSets.size >= COLD_SETS_PER_TENANT_HOUR) {
    throw new ExpectedToolError(
      "slack_dm_rate_limited",
      `This workspace has messaged ${COLD_SETS_PER_TENANT_HOUR} different people/groups who did not reach out, in the last hour. Post to a channel instead, or ask the user.`,
      { scope: "tenant_breadth", limit: COLD_SETS_PER_TENANT_HOUR },
    );
  }

  const rHits = prune(recipientHits.get(`${tenantId}::${rKey}`) ?? [], nowMs);
  if (rHits.length >= COLD_MSGS_PER_RECIPIENT_HOUR) {
    throw new ExpectedToolError(
      "slack_dm_rate_limited",
      `Already sent ${COLD_MSGS_PER_RECIPIENT_HOUR} unprompted messages to this recipient in the last hour. Stop and ask the user.`,
      { scope: "recipient_depth", limit: COLD_MSGS_PER_RECIPIENT_HOUR },
    );
  }

  const tHits = prune(tenantHits.get(tenantId) ?? [], nowMs);
  tHits.push(nowMs);
  rHits.push(nowMs);
  runSet.add(rKey);
  if (!tSets.has(rKey)) tSets.set(rKey, nowMs);
  tenantHits.set(tenantId, tHits);
  recipientHits.set(`${tenantId}::${rKey}`, rHits);
  tenantColdSets.set(tenantId, tSets);
  runColdSets.set(runKey, runSet);
}

export function __resetDmGuardForTests(): void {
  tenantHits.clear();
  recipientHits.clear();
  tenantColdSets.clear();
  runColdSets.clear();
}

export function dmRecipientsFromCall(
  toolName: string,
  args: unknown,
): string[] | null {
  const a = (args ?? {}) as Record<string, unknown>;
  const ids: string[] = [];
  if (typeof a.user_id === "string" && a.user_id) ids.push(a.user_id);
  if (Array.isArray(a.user_ids)) {
    for (const u of a.user_ids) if (typeof u === "string" && u) ids.push(u);
  }
  if (ids.length > 0) return ids;
  if (
    (toolName === "post_message" || toolName === "upload_file") &&
    typeof a.channel_id === "string" &&
    /^[DG]/i.test(a.channel_id)
  ) {
    return [a.channel_id];
  }
  return null;
}
