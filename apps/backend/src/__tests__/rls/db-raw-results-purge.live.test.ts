import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Client } from "pg";

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PROD_REF = "wmycgyjsenvgtczlupoe";
const SHOULD_RUN = !!(SUPA_URL && SUPA_SERVICE) && !SUPA_URL!.includes(PROD_REF);
const DAY = 86_400_000;
const PG_URL = process.env.ZAVI_TEST_PG_URL ?? process.env.SUPABASE_DB_URL;

describe.skipIf(!SHOULD_RUN)("database retention sweeps (live)", () => {
  let svc: SupabaseClient;
  const tenants: string[] = [];
  const ids: Record<string, string> = {};
  const runs: Record<string, string> = {};
  const calls = [
    { name: "operator_db__query", output_preview: "email: a@b.c" },
    { name: "github__read_file", output_preview: "code" },
  ];

  async function tenant(label: string, raw: string | null, chat: string | null, connected: boolean, settingsRow = true) {
    const { data, error } = await svc.from("tenants").insert({ display_name: label, kind: "test", slug: `${label}-${Date.now()}` }).select("id").single();
    if (error || !data) throw new Error(`tenant insert failed: ${error?.message}`);
    const id = data.id as string;
    tenants.push(id);
    ids[label] = id;
    if (connected) await svc.from("tenant_db_config").insert({ tenant_id: id, type: "postgres", schema_map: {} });
    if (settingsRow) await svc.from("tenant_db_settings").insert({ tenant_id: id, raw_results_retention: raw, chat_retention: chat });
    return id;
  }

  async function run(key: string, tenantId: string, status: string, finishedMsAgo: number | null, sentToAi = true, withLog = true) {
    const { data, error } = await svc
      .from("agent_runs")
      .insert({
        tenant_id: tenantId,
        agent_slug: "operator",
        agent_definition_hash: "x",
        trigger: "manual",
        status,
        enqueued_at: new Date(Date.now() - 40 * DAY).toISOString(),
        finished_at: finishedMsAgo === null ? null : new Date(Date.now() - finishedMsAgo).toISOString(),
        tool_calls: calls,
        output_text: `answer for ${key}`,
        parsed: { reply: `answer for ${key}` },
      })
      .select("id")
      .single();
    if (error || !data) throw new Error(`run insert failed: ${error?.message}`);
    runs[key] = data.id as string;
    await svc.from("agent_run_checkpoints").insert({ run_id: data.id, tenant_id: tenantId, iter: 1, messages_jsonb: [] });
    if (withLog) await svc.from("data_access_log").insert({
      tenant_id: tenantId, caller_kind: "agent", run_id: data.id, mode: "direct", dialect: "postgres",
      query_text: "select email from users", result: sentToAi ? "allowed" : "refused", sent_to_ai: sentToAi,
      created_at: new Date(Date.now() - (finishedMsAgo ?? 40 * DAY) - 60_000).toISOString(),
    });
  }

  const preview = async (key: string) =>
    ((await svc.from("agent_runs").select("tool_calls").eq("id", runs[key]).single()).data!.tool_calls as Array<{ output_preview: string }>)[0].output_preview;
  const checkpoints = async (key: string) => ((await svc.from("agent_run_checkpoints").select("id").eq("run_id", runs[key])).data ?? []).length;

  beforeAll(async () => {
    svc = createClient(SUPA_URL!, SUPA_SERVICE!, { auth: { persistSession: false } });
    const perRun = await tenant("ret-run", "run", "forever", true);
    await run("finished", perRun, "failed", 60 * 60 * 1000);
    await run("running", perRun, "running", null);
    await run("paused", perRun, "paused_awaiting_approval", null);
    const week = await tenant("ret-7", "7", "30", true);
    await run("old_done", week, "success", 8 * DAY);
    await run("young_done", week, "success", 2 * DAY);
    await run("old_paused", week, "paused_awaiting_child", null);
    const gone = await tenant("ret-gone", "7", null, false);
    await run("gone_done", gone, "success", 9 * DAY);
    const missing = await tenant("ret-missing", null, null, true, false);
    await run("missing_done", missing, "success", 60 * 60 * 1000);
    const legacy = await tenant("ret-legacy", null, null, true);
    await run("legacy_done", legacy, "success", 60 * DAY);

    const chat = await tenant("ret-chat", null, "30", true);
    await run("chat_sent", chat, "success", 40 * DAY, true);
    await run("chat_refused", chat, "success", 40 * DAY, false);
    const tighten = await tenant("ret-tighten", "30", null, true);
    await run("tighten_done", tighten, "success", 8 * DAY);
    const delrow = await tenant("ret-delrow", null, null, true);
    await run("delrow_done", delrow, "success", 60 * 60 * 1000);
    const legacyRun = await tenant("ret-coverage", "run", "forever", true);
    await run("coverage_done", legacyRun, "success", 60 * 60 * 1000, true, false);

    const { data: th } = await svc.from("agent_threads").insert({ tenant_id: chat, agent_slug: "operator", title: "t", synthetic: true }).select("id").single();
    const old = new Date(Date.now() - 40 * DAY).toISOString();
    for (const k of ["chat_sent", "chat_refused"]) {
      await svc.from("agent_thread_messages").insert({ thread_id: th!.id, tenant_id: chat, sender_role: "assistant", body: k, agent_run_id: runs[k], created_at: old });
      await svc.from("thread_event").insert({ tenant_id: chat, agent_run_id: runs[k], agent_slug: "operator", kind: "chat_assistant", body: { text: k } });
    }
  });

  afterAll(async () => {
    for (const t of tenants) await svc.from("tenants").delete().eq("id", t);
  });

  it("raw results: finished runs only, on every setting; running and paused runs untouched", async () => {
    expect((await svc.rpc("purge_db_raw_results", { p_batch_limit: 2000 })).error).toBeNull();
    expect(await preview("finished")).toBe("");
    expect(await checkpoints("finished")).toBe(0);
    for (const k of ["running", "paused", "old_paused", "young_done"]) {
      expect(await preview(k)).toBe("email: a@b.c");
      expect(await checkpoints(k)).toBe(1);
    }
    expect(await preview("old_done")).toBe("");
    expect(await checkpoints("old_done")).toBe(0);
  });

  it("settings outlive a disconnect (tombstone row, no connection)", async () => {
    expect(await preview("gone_done")).toBe("");
  });

  it("fails closed when the settings row is missing; a legacy NULL row keeps its rows", async () => {
    expect(await preview("missing_done")).toBe("");
    expect(await checkpoints("missing_done")).toBe(0);
    expect(await preview("legacy_done")).toBe("email: a@b.c");
    expect(await checkpoints("legacy_done")).toBe(1);
  });

  it("due-ness follows the CURRENT settings: a tightened setting and a deleted settings row apply to rows already queued", async () => {
    expect(await preview("tighten_done")).toBe("email: a@b.c");
    await svc.from("tenant_db_settings").update({ raw_results_retention: "7" }).eq("tenant_id", ids["ret-tighten"]);
    await svc.from("tenant_db_settings").delete().eq("tenant_id", ids["ret-delrow"]);
    expect((await svc.rpc("purge_db_raw_results", { p_batch_limit: 2000 })).error).toBeNull();
    expect(await preview("tighten_done")).toBe("");
    expect(await preview("delrow_done")).toBe("");
  });

  it("the coverage walk enqueues a legacy run with database tool calls but no log row", async () => {
    expect(await preview("coverage_done")).toBe("email: a@b.c");
    for (let i = 0; i < 50; i++) {
      const { data, error } = await svc.rpc("enqueue_db_run_retention_page", { p_limit: 20000 });
      expect(error).toBeNull();
      if ((data as Array<{ wrapped: boolean }>)[0]!.wrapped) break;
    }
    expect((await svc.rpc("purge_db_raw_results", { p_batch_limit: 2000 })).error).toBeNull();
    expect(await preview("coverage_done")).toBe("");
  });

  it("chat answers: only runs that sent database results to the model", async () => {
    expect((await svc.rpc("purge_db_chat_answers", { p_batch_limit: 2000 })).error).toBeNull();
    const { data } = await svc.from("agent_thread_messages").select("body").in("agent_run_id", [runs.chat_sent, runs.chat_refused]);
    expect((data ?? []).map((r) => r.body)).toEqual(["chat_refused"]);
    const { data: ev } = await svc.from("thread_event").select("agent_run_id").eq("kind", "chat_assistant").in("agent_run_id", [runs.chat_sent, runs.chat_refused]);
    expect((ev ?? []).map((r) => r.agent_run_id)).toEqual([runs.chat_refused]);
    const { data: sentRun } = await svc.from("agent_runs").select("output_text, parsed, raw_response_text").eq("id", runs.chat_sent).single();
    expect(sentRun).toEqual({ output_text: "", parsed: null, raw_response_text: null });
    const { data: keptRun } = await svc.from("agent_runs").select("output_text").eq("id", runs.chat_refused).single();
    expect(keptRun!.output_text).toBe("answer for chat_refused");
  });

  it("the purges drain from the queue and report backlog", async () => {
    const { data, error } = await svc.rpc("db_retention_backlog");
    expect(error).toBeNull();
    expect(data).toMatchObject({ raw_results: expect.any(Number), chat_answers: 0, access_log: 0 });
  });

  it("a new read after the run was purged re-opens it, and the new results are purged too", async () => {
    expect(await preview("finished")).toBe("");
    const t = tenants[0]!;
    await svc.from("agent_runs").update({ tool_calls: calls }).eq("id", runs.finished);
    await svc.from("data_access_log").insert({ tenant_id: t, caller_kind: "agent", run_id: runs.finished, mode: "direct", dialect: "postgres", query_text: "select 2", result: "allowed", sent_to_ai: true });
    const q = (await svc.from("db_run_retention").select("raw_purged_at, version").eq("run_id", runs.finished).single()).data!;
    expect(q.raw_purged_at).toBeNull();
    expect(Number(q.version)).toBeGreaterThan(0);
    expect((await svc.rpc("purge_db_raw_results", { p_batch_limit: 2000 })).error).toBeNull();
    expect(await preview("finished")).toBe("");
  });

  it.skipIf(!PG_URL)("a read racing a purge waits for it, re-opens the run, and the next purge takes the new results", async () => {
    const a = new Client({ connectionString: PG_URL });
    const b = new Client({ connectionString: PG_URL });
    await a.connect();
    await b.connect();
    try {
      const t = tenants[0]!;
      await svc.from("agent_runs").update({ tool_calls: calls }).eq("id", runs.finished);
      await svc.from("db_run_retention").update({ raw_purged_at: null }).eq("run_id", runs.finished);
      await a.query("BEGIN");
      await a.query("SELECT public.purge_db_raw_results(2000)");
      const read = b.query(
        "INSERT INTO public.data_access_log (tenant_id, caller_kind, run_id, mode, dialect, query_text, result, sent_to_ai) VALUES ($1, 'agent', $2, 'direct', 'postgres', 'select 3', 'allowed', true)",
        [t, runs.finished],
      );
      let readDone = false;
      void read.then(() => (readDone = true));
      await new Promise((r) => setTimeout(r, 300));
      expect(readDone).toBe(false);
      await a.query("COMMIT");
      await read;
      await svc.from("agent_runs").update({ tool_calls: calls }).eq("id", runs.finished);
      const q = (await svc.from("db_run_retention").select("raw_purged_at").eq("run_id", runs.finished).single()).data!;
      expect(q.raw_purged_at).toBeNull();
      expect((await svc.rpc("purge_db_raw_results", { p_batch_limit: 2000 })).error).toBeNull();
      expect(await preview("finished")).toBe("");
    } finally {
      await a.end().catch(() => undefined);
      await b.end().catch(() => undefined);
    }
  });

  it("a run that becomes terminal later is purged on a later tick, never skipped", async () => {
    await svc.from("agent_runs").update({ status: "success", finished_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() }).eq("id", runs.running);
    expect((await svc.rpc("purge_db_raw_results", { p_batch_limit: 2000 })).error).toBeNull();
    expect(await preview("running")).toBe("");
  });

  it("decides from live run state: a queue row whose finished_at copy is missing is still purged", async () => {
    const t = (await svc.from("tenants").insert({ display_name: "ret-live", kind: "test", slug: `ret-live-${Date.now()}` }).select("id").single()).data!.id as string;
    tenants.push(t);
    await svc.from("tenant_db_config").insert({ tenant_id: t, type: "postgres", schema_map: {} });
    await svc.from("tenant_db_settings").insert({ tenant_id: t, raw_results_retention: "run", chat_retention: "30" });
    await run("live_done", t, "success", 60 * 60 * 1000);
    await svc.from("db_run_retention").update({ finished_at: null }).eq("run_id", runs.live_done);
    expect((await svc.rpc("purge_db_raw_results", { p_batch_limit: 2000 })).error).toBeNull();
    expect(await preview("live_done")).toBe("");
  });

  it("a later read of the same run that IS sent to the model makes its answer expire", async () => {
    const t = (await svc.from("tenants").insert({ display_name: "ret-sent", kind: "test", slug: `ret-sent-${Date.now()}` }).select("id").single()).data!.id as string;
    tenants.push(t);
    await svc.from("tenant_db_config").insert({ tenant_id: t, type: "postgres", schema_map: {} });
    await svc.from("tenant_db_settings").insert({ tenant_id: t, raw_results_retention: "30", chat_retention: "30" });
    await run("late_sent", t, "success", 40 * DAY, false);
    await svc.from("data_access_log").insert({ tenant_id: t, caller_kind: "agent", run_id: runs.late_sent, mode: "direct", dialect: "postgres", query_text: "select 4", result: "allowed", sent_to_ai: true, created_at: new Date(Date.now() - 40 * DAY - 30_000).toISOString() });
    expect((await svc.rpc("purge_db_chat_answers", { p_batch_limit: 2000 })).error).toBeNull();
    const r = (await svc.from("agent_runs").select("output_text").eq("id", runs.late_sent).single()).data!;
    expect(r.output_text).toBe("");
  });

  it("is idempotent", async () => {
    expect((await svc.rpc("purge_db_raw_results", { p_batch_limit: 2000 })).error).toBeNull();
    expect(await preview("finished")).toBe("");
    expect(await preview("paused")).toBe("email: a@b.c");
  });
});
