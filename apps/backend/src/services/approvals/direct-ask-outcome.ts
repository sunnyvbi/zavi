import { asTenantId, tenantClient } from "@/services/tenant-client";
import { parseEnvelope } from "./approval-envelope";
import { ENVELOPE_CREATE_CLASSES } from "./envelope-classes";

export type DirectAskOutcome = {
  tenant_id: string;
  action_id: string;
  ok: boolean;
  text: string | null;
  code?: string | null;
  created?: { object_type?: string; id?: string } | null;
};

export type TellResult = "told" | "already_told" | "not_a_direct_ask" | "no_surface" | "failed";

type RunRow = { id: string; trigger: string | null; payload: unknown; agent_slug: string | null };

export type TellDeps = {
  readAction?: (tenant_id: string, action_id: string) => Promise<{ channel_slug: string; exec_class: string | null; approval_envelope: unknown } | null>;
  readRun?: (tenant_id: string, run_id: string) => Promise<RunRow | null>;
  claim?: (tenant_id: string, key: string) => Promise<"claimed" | "taken" | "error">;
  release?: (tenant_id: string, key: string) => Promise<boolean>;
  done?: (tenant_id: string, key: string) => Promise<boolean>;
  chat?: (tenant_id: string, thread_id: string, body: string, action_id: string, ok: boolean) => Promise<boolean>;
  slack?: (tenant_id: string, routing: { channel_id: string; thread_ts: string; team_id?: string }, body: string, key: string, run_id: string) => Promise<boolean>;
  email?: (tenant_id: string, run: RunRow, body: string, channel_slug: string) => Promise<boolean>;
  waitForFilingRun?: (tenant_id: string, action_id: string, surface: { thread_id: string | null; email: boolean }) => Promise<void>;
};

export function directAskOutcomeText(o: Pick<DirectAskOutcome, "ok" | "text" | "created">, channelName: string): string {
  const said = (o.text ?? "").trim();
  if (o.ok) return said || `Your ${channelName} ad is on.`;
  const made = o.created?.id && !said.includes(o.created.id) ? ` Zavi created ${o.created.object_type ?? "an object"} ${o.created.id} on ${channelName}; check it there.` : "";
  return `Your ${channelName} ad didn't finish setting up.${said ? ` ${said}` : " The change did not go through."}${made}`;
}

export async function tellDirectAskOutcome(o: DirectAskOutcome, deps: TellDeps = {}): Promise<TellResult> {
  try {
    const action = await (deps.readAction ?? readAction)(o.tenant_id, o.action_id);
    if (!action || !ENVELOPE_CREATE_CLASSES.has(action.exec_class ?? "")) return "not_a_direct_ask";
    const env = parseEnvelope(action.approval_envelope);
    if (!env || env.tenant_id !== o.tenant_id || !env.envelope_id.startsWith("ask:")) return "not_a_direct_ask";
    const root = await (deps.readRun ?? readRun)(o.tenant_id, env.envelope_id.slice(4));
    if (!root) return "no_surface";
    const key = `ad-ask-outcome:${o.action_id}:${o.ok ? "ok" : o.code || "failed"}`;
    const { extractChatThreadId, extractSlackRouting } = await import("@/../workers/functions/dispatch-notice");
    await (deps.waitForFilingRun ?? waitForFilingRun)(o.tenant_id, o.action_id, { thread_id: extractChatThreadId(root) ?? null, email: !extractChatThreadId(root) && !extractSlackRouting(root) }).catch(() => undefined);
    const claimed = await (deps.claim ?? claim)(o.tenant_id, key);
    if (claimed === "taken") return "already_told";
    const { channelName } = await import("@/services/growth/ad-plan-shape");
    const body = directAskOutcomeText(o, channelName(action.channel_slug));
    let delivered = false;
    let surface = false;
    const thread = extractChatThreadId(root);
    const routing = extractSlackRouting(root);
    if (thread) {
      surface = true;
      delivered = await (deps.chat ?? postChat)(o.tenant_id, thread, body, o.action_id, o.ok);
    } else if (routing) {
      surface = true;
      delivered = await (deps.slack ?? postSlack)(o.tenant_id, routing, body, key, root.id);
    } else if (root.trigger === "email") {
      surface = true;
      delivered = await (deps.email ?? sendEmail)(o.tenant_id, root, body, action.channel_slug);
    }
    if (!delivered) {
      if (claimed === "claimed") {
        const rel = deps.release ?? release;
        if (!(await rel(o.tenant_id, key).catch(() => false))) await rel(o.tenant_id, key).catch(() => false);
      }
      return surface ? "failed" : "no_surface";
    }
    if (claimed === "claimed") {
      const done = deps.done ?? markDone;
      if (!(await done(o.tenant_id, key).catch(() => false))) await done(o.tenant_id, key).catch(() => false);
    }
    return "told";
  } catch (e) {
    console.warn(`[direct-ask-outcome] ${o.action_id}: ${(e as Error).message}`);
    return "failed";
  }
}

export const FILING_RUN_WAIT_MS = 300_000;
export const FILING_REPLY_WAIT_MS = 10_000;
export const EMAIL_REPLY_WAIT_MS = 120_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function waitForFilingRun(tenant_id: string, action_id: string, surface: { thread_id: string | null; email: boolean }): Promise<void> {
  const db = tenantClient(asTenantId(tenant_id));
  const until = async (end: number, pollMs: number, check: () => Promise<boolean>) => {
    for (;;) {
      if (await check().catch(() => false)) return;
      if (Date.now() >= end) return;
      await sleep(pollMs);
    }
  };
  let runId: string | null = null;
  await until(Date.now() + FILING_REPLY_WAIT_MS, 1000, async () => {
    const { data, error } = await db.from("channel_actions").select("run_id").eq("id", action_id).maybeSingle();
    if (error) throw new Error(error.message);
    runId = (data as { run_id?: string | null } | null)?.run_id ?? null;
    return true;
  });
  if (!runId) return;
  const id = runId;
  await until(Date.now() + FILING_RUN_WAIT_MS, 3000, async () => {
    const { data, error } = await db.from("agent_runs").select("status").eq("id", id).maybeSingle();
    if (error) throw new Error(error.message);
    const status = (data as { status?: string } | null)?.status;
    return status !== "queued" && status !== "running";
  });
  if (surface.thread_id) {
    const thread = surface.thread_id;
    await until(Date.now() + FILING_REPLY_WAIT_MS, 1000, async () => {
      const { data, error } = await db.from("agent_thread_messages").select("id").eq("thread_id", thread).eq("agent_run_id", id).limit(1);
      if (error) throw new Error(error.message);
      return (data ?? []).length > 0;
    });
  } else if (surface.email) {
    await until(Date.now() + EMAIL_REPLY_WAIT_MS, 2000, async () => {
      const { data, error } = await db.from("email_messages").select("id").eq("dedup_key", `out:${id}`).limit(1);
      if (error) throw new Error(error.message);
      return (data ?? []).length > 0;
    });
  }
}

async function readAction(tenant_id: string, action_id: string) {
  const { data, error } = await tenantClient(asTenantId(tenant_id)).from("channel_actions").select("channel_slug, exec_class, approval_envelope").eq("id", action_id).maybeSingle();
  if (error) throw new Error(`channel_actions read failed: ${error.message}`);
  return (data as { channel_slug: string; exec_class: string | null; approval_envelope: unknown } | null) ?? null;
}

async function readRun(tenant_id: string, run_id: string): Promise<RunRow | null> {
  const { data, error } = await tenantClient(asTenantId(tenant_id)).from("agent_runs").select("id, trigger, payload, agent_slug").eq("id", run_id).maybeSingle();
  if (error) throw new Error(`agent_runs read failed: ${error.message}`);
  return (data as RunRow | null) ?? null;
}

async function claim(tenant_id: string, key: string): Promise<"claimed" | "taken" | "error"> {
  const db = tenantClient(asTenantId(tenant_id));
  const { error } = await db.from("slack_triage_claims").insert({ event_id: key, status: "processing" });
  if (!error) return "claimed";
  if ((error as { code?: string }).code !== "23505") return "error";
  const { data } = await db.from("slack_triage_claims").select("status").eq("event_id", key).maybeSingle();
  return (data as { status?: string } | null)?.status === "done" ? "taken" : "claimed";
}

async function release(tenant_id: string, key: string): Promise<boolean> {
  const { error } = await tenantClient(asTenantId(tenant_id)).from("slack_triage_claims").delete().eq("event_id", key);
  return !error;
}

async function markDone(tenant_id: string, key: string): Promise<boolean> {
  const { error } = await tenantClient(asTenantId(tenant_id)).from("slack_triage_claims").update({ status: "done", replied_at: new Date().toISOString() }).eq("event_id", key);
  return !error;
}

async function postChat(tenant_id: string, thread_id: string, body: string, action_id: string, ok: boolean): Promise<boolean> {
  const db = tenantClient(asTenantId(tenant_id));
  const { data: own } = await db.from("agent_threads").select("id").eq("id", thread_id).maybeSingle();
  if (!own) return false;
  const { error } = await db.from("agent_thread_messages").insert({
    thread_id,
    sender_role: "assistant",
    body,
    meta: { dispatch_notice: true, channel_action_id: action_id, ok },
    agent_run_id: null,
  });
  if (error) return false;
  await db.from("agent_threads").update({ last_message_at: new Date().toISOString() }).eq("id", thread_id);
  return true;
}

async function postSlack(tenant_id: string, routing: { channel_id: string; thread_ts: string; team_id?: string }, body: string, key: string, run_id: string): Promise<boolean> {
  const { enqueueSlackOutbox } = await import("@/services/slack/outbox");
  const { mdToMrkdwn } = await import("@/services/tools/slack/mrkdwn");
  const seq = await enqueueSlackOutbox({ tenant_id, channel_id: routing.channel_id, thread_ts: routing.thread_ts, team_id: routing.team_id, run_id, kind: "ad_launch_result", body: mdToMrkdwn(body), idempotency_key: key, depends_on_answer: true });
  return seq !== null;
}

async function sendEmail(tenant_id: string, run: RunRow, body: string, channel_slug: string): Promise<boolean> {
  const { sendAgentResultEmail } = await import("@/email/sendAgentResult");
  const r = await sendAgentResultEmail({ tenant_id, agent_slug: run.agent_slug ?? "operator", run_id: run.id, body, link: { path: `/channels/${channel_slug}`, text: "Open the channel" } });
  return r.sent;
}
