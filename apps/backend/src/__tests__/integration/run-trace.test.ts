
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Request, Response } from "express";
import { assembleTraceJsonl } from "@/../workers/functions/persist-run-trace";
import { staffRunTrace } from "@/routes/admin/run-trace";

const isIntegration = process.env.INTEGRATION === "1";
const sb: SupabaseClient | null = isIntegration
  ? createClient(
      process.env.SUPABASE_URL || "http://127.0.0.1:54321",
      process.env.SUPABASE_SERVICE_ROLE_KEY || "service-role-key-from-supabase-status",
    )
  : null;

const TENANT_ID = "a5a5a5a5-0000-4000-8000-00000000a5a5";
const TENANT_SLUG = "run-trace-itest";
const RUN_ID = "a5a5a5a5-1111-4111-8111-00000000a5a5";
const BUCKET = "agent-run-traces";

function mockRes(): Response & { _status: number; _json: unknown } {
  const r: Partial<Response> & { _status: number; _json: unknown } = {
    _status: 200,
    _json: undefined,
    status(code: number) {
      this._status = code;
      return this as unknown as Response;
    },
    json(body: unknown) {
      this._json = body;
      return this as unknown as Response;
    },
  };
  return r as Response & { _status: number; _json: unknown };
}

describe.skipIf(!isIntegration)("run-trace staff route (integration)", () => {
  beforeAll(async () => {
    await sb!.from("tenants").upsert({ id: TENANT_ID, slug: TENANT_SLUG, display_name: "RunTrace ITest" });

    await sb!.from("agent_runs").upsert({
      id: RUN_ID,
      tenant_id: TENANT_ID,
      agent_slug: "engineer",
      agent_definition_hash: "itest-hash-a5",
      trigger: "cron",
      status: "success",
      output_text: "done — reached host at jane@example.com",
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
    });

    await sb!.from("agent_run_events").delete().eq("agent_run_id", RUN_ID);
    await sb!.from("agent_run_events").insert([
      { agent_run_id: RUN_ID, tenant_id: TENANT_ID, stage: "claimed", meta: {} },
      { agent_run_id: RUN_ID, tenant_id: TENANT_ID, stage: "tool_use_completed", meta: { tool_name: "github__read_file", ms: 12 } },
      { agent_run_id: RUN_ID, tenant_id: TENANT_ID, stage: "completed", meta: {} },
    ]);

    const { data: events } = await sb!
      .from("agent_run_events")
      .select("id, stage, meta, created_at")
      .eq("agent_run_id", RUN_ID)
      .order("created_at", { ascending: true });
    const run = {
      id: RUN_ID,
      tenant_id: TENANT_ID,
      agent_slug: "engineer",
      trigger: "cron",
      status: "success",
      output_text: "done — reached host at jane@example.com",
      error: null,
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
    };
    const { jsonl, eventCount } = assembleTraceJsonl(run, (events ?? []) as never[], []);
    const buf = Buffer.from(jsonl, "utf8");
    const storagePath = `${TENANT_ID}/${RUN_ID}/trace.jsonl`;
    await sb!.storage.from(BUCKET).upload(storagePath, buf, {
      contentType: "application/x-ndjson",
      upsert: true,
    });
    await sb!.from("agent_run_trace").upsert(
      {
        run_id: RUN_ID,
        tenant_id: TENANT_ID,
        storage_path: storagePath,
        sha256: "deadbeef",
        byte_size: buf.byteLength,
        event_count: eventCount,
        expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      },
      { onConflict: "run_id" },
    );
  });

  afterAll(async () => {
    if (!sb) return;
    await sb.storage.from(BUCKET).remove([`${TENANT_ID}/${RUN_ID}/trace.jsonl`]);
    await sb.from("agent_run_trace").delete().eq("run_id", RUN_ID);
    await sb.from("agent_run_events").delete().eq("agent_run_id", RUN_ID);
    await sb.from("agent_runs").delete().eq("id", RUN_ID);
    await sb.from("tenants").delete().eq("id", TENANT_ID);
  });

  it("(a) handler refuses without req.staff (assertStaff throws)", async () => {
    const req = { params: { run_id: RUN_ID } } as unknown as Request;
    const res = mockRes();
    await expect(staffRunTrace(req, res)).rejects.toThrow();
    expect(res._json).toBeUndefined();
  });

  it("(b)+(c) staff GET returns a 7d-capped signed URL; blob event_count matches agent_run_events", async () => {
    const req = {
      params: { run_id: RUN_ID },
      staff: { user_id: "staff-1", email: "ravi@upcar.ai" },
    } as unknown as Request;
    const res = mockRes();
    await staffRunTrace(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { signed_url: string; expires_in: number; event_count: number };
    expect(body.signed_url).toMatch(/^https?:\/\//);
    expect(body.expires_in).toBeLessThanOrEqual(604800);
    expect(body.expires_in).toBeGreaterThan(604800 - 60);

    const { count } = await sb!
      .from("agent_run_events")
      .select("id", { count: "exact", head: true })
      .eq("agent_run_id", RUN_ID);
    expect(body.event_count).toBe(count);

    const fetched = await fetch(body.signed_url);
    const text = await fetched.text();
    const records = text.trimEnd().split("\n").map((l) => JSON.parse(l));
    const eventLines = records.filter((r) => r.kind === "event");
    expect(eventLines).toHaveLength(count!);
    const header = records.find((r) => r.kind === "header");
    expect(header.output_text).not.toContain("jane@example.com");
  });

  it("(d) agent_run_trace.expires_at ≤ created_at + 30d", async () => {
    const { data } = await sb!
      .from("agent_run_trace")
      .select("created_at, expires_at")
      .eq("run_id", RUN_ID)
      .single();
    const row = data as { created_at: string; expires_at: string };
    const createdMs = new Date(row.created_at).getTime();
    const expiresMs = new Date(row.expires_at).getTime();
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    expect(expiresMs - createdMs).toBeLessThanOrEqual(thirtyDaysMs + 5000);
    expect(expiresMs).toBeGreaterThan(createdMs);
  });

  it("404 on a run with no trace row", async () => {
    const req = {
      params: { run_id: "a5a5a5a5-9999-4999-8999-00000000a5a5" },
      staff: { user_id: "staff-1", email: "ravi@upcar.ai" },
    } as unknown as Request;
    const res = mockRes();
    await staffRunTrace(req, res);
    expect(res._status).toBe(404);
    expect((res._json as { error: { code: string } }).error.code).toBe("trace_not_found");
  });

  it("404 trace_expired when expires_at is already past (GC-lag guard)", async () => {
    await sb!
      .from("agent_run_trace")
      .update({ expires_at: new Date(Date.now() - 60_000).toISOString() })
      .eq("run_id", RUN_ID);
    const req = {
      params: { run_id: RUN_ID },
      staff: { user_id: "staff-1", email: "ravi@upcar.ai" },
    } as unknown as Request;
    const res = mockRes();
    await staffRunTrace(req, res);
    expect(res._status).toBe(404);
    expect((res._json as { error: { code: string } }).error.code).toBe("trace_expired");
    await sb!
      .from("agent_run_trace")
      .update({ expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() })
      .eq("run_id", RUN_ID);
  });

  it("400 on a non-UUID run_id", async () => {
    const req = {
      params: { run_id: "not-a-uuid" },
      staff: { user_id: "staff-1", email: "ravi@upcar.ai" },
    } as unknown as Request;
    const res = mockRes();
    await staffRunTrace(req, res);
    expect(res._status).toBe(400);
    expect((res._json as { error: { code: string } }).error.code).toBe("invalid_run_id");
  });
});
