
import { isChannelSlug } from "@zavi/shared";
import { asTenantId, tenantClient } from "@/services/tenant-client";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PageOrigin = {
  pageChannel: string;
  agentSlug: string;
  pageChannelActionId?: string | null;
};

export type StampInput = PageOrigin & {
  tenantId: string;
  userId: string;
  threadId: string;
};

type Result = { data?: unknown; error: { message?: string } | null };

export type OriginFilter = PromiseLike<Result> & {
  eq(col: string, val: unknown): OriginFilter;
  is(col: string, val: null): OriginFilter;
  maybeSingle(): PromiseLike<Result>;
};

export type OriginDb = {
  from(table: string): {
    select(cols: string): OriginFilter;
    update(values: Record<string, unknown>): OriginFilter;
  };
};

export type StampDeps = {
  db: (tenantId: string) => OriginDb;
  warn: (msg: string) => void;
};

const realDeps: StampDeps = {
  db: (tenantId) => tenantClient(asTenantId(tenantId)) as unknown as OriginDb,
  warn: (msg) => console.warn(msg),
};

async function verifiedCardId(
  db: OriginDb,
  pageChannel: string,
  cardId: string | null | undefined,
): Promise<string | null> {
  if (!cardId || !UUID_RE.test(cardId)) return null;
  const { data, error } = await db
    .from("channel_actions")
    .select("id, channel_slug")
    .eq("id", cardId.toLowerCase())
    .maybeSingle();
  if (error) throw new Error(`card read failed: ${error.message ?? String(error)}`);
  const row = data as { id: string; channel_slug: string } | null;
  if (!row || row.channel_slug !== pageChannel) return null;
  return row.id;
}

async function attempt(input: StampInput, db: OriginDb): Promise<void> {
  const card = await verifiedCardId(db, input.pageChannel, input.pageChannelActionId);
  const { error } = await db
    .from("agent_threads")
    .update({ channel_slug: input.pageChannel, channel_action_id: card })
    .eq("id", input.threadId)
    .eq("user_id", input.userId)
    .eq("agent_slug", input.agentSlug)
    .is("channel_slug", null);
  if (error) throw new Error(`thread stamp failed: ${error.message ?? String(error)}`);
}

export async function stampThreadChannelOrigin(
  input: StampInput,
  deps: StampDeps = realDeps,
): Promise<void> {
  if (!isChannelSlug(input.pageChannel)) return;
  if (!UUID_RE.test(input.threadId)) return;
  const db = deps.db(input.tenantId);
  for (let i = 1; i <= 2; i++) {
    try {
      await attempt(input, db);
      return;
    } catch (e) {
      if (i === 2) {
        deps.warn(
          `[thread-channel-origin] could not stamp thread ${input.threadId} with ${input.pageChannel}: ${(e as Error).message}`,
        );
      }
    }
  }
}
