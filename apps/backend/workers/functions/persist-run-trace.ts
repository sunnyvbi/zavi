
import { createHash } from "node:crypto";
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { redactValue } from "@/services/redactor";

const BUCKET = "agent-run-traces";
const TRACE_MIME = "application/x-ndjson";
const RETENTION_DAYS = 30;

const MAX_EVENTS = 50_000;
const MAX_REASONING_ROWS = 50;
const MAX_TEXT_CHARS = 20_000;
const MAX_REASONING_CHARS = 4_000;

type RunRow = {
  id: string;
  tenant_id: string;
  agent_slug: string;
  trigger: string;
  status: string;
  output_text: string | null;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
};

type EventRow = {
  id: number | string;
  stage: string;
  meta: Record<string, unknown> | null;
  created_at: string;
};

type ReasoningRow = {
  body: { text?: string; iter?: number } | null;
  created_at: string;
};

function redactText(
  s: string | null | undefined,
  maxChars = MAX_TEXT_CHARS,
): string | null {
  if (s === null || s === undefined) return null;
  const redacted = redactValue("run_trace_text", String(s));
  const out = typeof redacted === "string" ? redacted : String(redacted);
  return out.slice(0, maxChars);
}

export function assembleTraceJsonl(
  run: RunRow,
  events: EventRow[],
  reasoning: ReasoningRow[],
  maxEvents: number = MAX_EVENTS,
): { jsonl: string; eventCount: number; truncated: boolean } {
  const cappedEvents = events.slice(0, maxEvents);
  const cappedReasoning = reasoning.slice(0, MAX_REASONING_ROWS);
  const truncated = events.length >= maxEvents;

  const header = {
    kind: "header",
    run_id: run.id,
    agent_slug: run.agent_slug,
    trigger: run.trigger,
    status: run.status,
    started_at: run.started_at,
    finished_at: run.finished_at,
    event_count: cappedEvents.length,
    truncated,
    output_text: redactText(run.output_text),
    error: redactText(run.error),
    reasoning: cappedReasoning.map((r) => ({
      iter: typeof r.body?.iter === "number" ? r.body.iter : null,
      created_at: r.created_at,
      text: redactText(r.body?.text ?? "", MAX_REASONING_CHARS),
    })),
  };

  const eventLines = cappedEvents.map((e) =>
    JSON.stringify({
      kind: "event",
      seq: e.id,
      stage: e.stage,
      meta: e.meta ?? {},
      created_at: e.created_at,
    }),
  );

  const jsonl = [JSON.stringify(header), ...eventLines].join("\n") + "\n";
  return { jsonl, eventCount: cappedEvents.length, truncated };
}

async function persistRunTrace(
  run_id: string,
): Promise<{ persisted: boolean; bytes: number; events: number; truncated: boolean }> {
  if (process.env.PRAXIS_PERSIST_RUN_TRACE_ENABLED === "0") {
    return { persisted: false, bytes: 0, events: 0, truncated: false };
  }

  const svc = serviceClient();

  const { data: runData, error: runErr } = await svc
    .from("agent_runs")
    .select(
      "id, tenant_id, agent_slug, trigger, status, output_text, error, started_at, finished_at",
    )
    .eq("id", run_id)
    .maybeSingle();
  if (runErr) throw new Error(`agent_runs read failed: ${runErr.message}`);
  if (!runData) return { persisted: false, bytes: 0, events: 0, truncated: false };
  const run = runData as RunRow;

  const { data: eventData, error: evErr } = await svc
    .from("agent_run_events")
    .select("id, stage, meta, created_at")
    .eq("agent_run_id", run_id)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(MAX_EVENTS);
  if (evErr) throw new Error(`agent_run_events read failed: ${evErr.message}`);
  const events = (eventData ?? []) as EventRow[];

  const { data: reasoningData, error: rErr } = await svc
    .from("thread_event")
    .select("body, created_at")
    .eq("agent_run_id", run_id)
    .eq("kind", "reasoning")
    .order("created_at", { ascending: true })
    .limit(MAX_REASONING_ROWS);
  if (rErr) {
    console.warn(
      `[persist-run-trace] reasoning read failed for ${run_id} (trace persisted without reasoning context): ${rErr.message}`,
    );
  }
  const reasoning = (reasoningData ?? []) as ReasoningRow[];

  const { jsonl, eventCount, truncated } = assembleTraceJsonl(run, events, reasoning);
  const buf = Buffer.from(jsonl, "utf8");
  const sha256 = createHash("sha256").update(buf).digest("hex");

  const storagePath = `${run.tenant_id}/${run.id}/trace.jsonl`;
  const { error: upErr } = await svc.storage
    .from(BUCKET)
    .upload(storagePath, buf, { contentType: TRACE_MIME, upsert: true });
  if (upErr) throw new Error(`trace upload failed: ${upErr.message}`);

  const anchorIso = run.finished_at ?? run.started_at ?? new Date().toISOString();
  const expiresAt = new Date(
    new Date(anchorIso).getTime() + RETENTION_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const { error: rowErr } = await svc.from("agent_run_trace").upsert(
    {
      run_id: run.id,
      tenant_id: run.tenant_id,
      storage_path: storagePath,
      sha256,
      byte_size: buf.byteLength,
      event_count: eventCount,
      expires_at: expiresAt,
    },
    { onConflict: "run_id" },
  );
  if (rowErr) throw new Error(`agent_run_trace upsert failed: ${rowErr.message}`);

  return { persisted: true, bytes: buf.byteLength, events: eventCount, truncated };
}

export const persistRunTraceFn = inngest.createFunction(
  { id: "persist-run-trace", retries: 1, concurrency: 4 },
  { event: "agent.run.terminal" },
  async ({ event, step, logger }) => {
    const run_id = event.data.run_id as string;
    if (!run_id) {
      logger.warn("[persist-run-trace] missing run_id; no-op");
      return { persisted: false, bytes: 0, events: 0, truncated: false };
    }
    const res = await step.run("persist-trace", () => persistRunTrace(run_id));
    logger.info(
      `persist-run-trace ${run_id}: persisted=${res.persisted} bytes=${res.bytes} events=${res.events} truncated=${res.truncated}`,
    );
    return res;
  },
);
