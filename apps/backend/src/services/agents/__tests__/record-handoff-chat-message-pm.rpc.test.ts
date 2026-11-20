import { describe, it, expect, beforeAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";
const CROSS_TENANT = "e0fe9ea8-0000-0000-0000-000000000000";

function loadEnv(): { url: string; serviceKey: string } | null {
  try {
    const envPath = resolve(__dirname, "../../../../.env");
    const raw = readFileSync(envPath, "utf8");
    const get = (k: string) => {
      const m = raw.match(new RegExp(`^${k}=(.*)$`, "m"));
      return m ? m[1].trim() : "";
    };
    const url = get("SUPABASE_URL");
    const serviceKey = get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !serviceKey) return null;
    return { url, serviceKey };
  } catch {
    return null;
  }
}

describe.skip("record_handoff_chat_message — PM widening (Slice 3, prod RPC)", () => {
  let sb: SupabaseClient;
  const created = { threadIds: [] as string[], runIds: [] as string[], messageIds: [] as string[] };

  beforeAll(() => {
    const env = loadEnv();
    if (!env) throw new Error("apps/backend/.env missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
    sb = createClient(env.url, env.serviceKey, { auth: { persistSession: false } });
  });

  async function makeThread(tenant: string, agent_slug: string): Promise<string> {
    const { data, error } = await sb
      .from("agent_threads")
      .insert({ tenant_id: tenant, agent_slug, title: "[pm-handoff-rpc-test]" })
      .select("id")
      .single();
    if (error) throw new Error(`thread insert failed: ${error.message}`);
    created.threadIds.push(data.id);
    return data.id;
  }

  async function makeHandoffRun(tenant: string, operatorThreadId: string | null, trigger = "handoff"): Promise<string> {
    const payload = operatorThreadId ? { operator_thread_id: operatorThreadId, intent: "x" } : { intent: "x" };
    const { data, error } = await sb
      .from("agent_runs")
      .insert({ tenant_id: tenant, agent_slug: "engineer", trigger, status: "succeeded", payload })
      .select("id")
      .single();
    if (error) throw new Error(`run insert failed: ${error.message}`);
    created.runIds.push(data.id);
    return data.id;
  }

  async function callRpc(threadId: string, tenant: string, runId: string, body = "hello from the engineer") {
    return sb.rpc("record_handoff_chat_message", {
      p_operator_thread_id: threadId,
      p_tenant_id: tenant,
      p_run_id: runId,
      p_body: body,
    });
  }

  it("ACCEPTS a pm-parent handoff postback into a pm thread", async () => {
    const pmThread = await makeThread(TENANT, "pm");
    const childRun = await makeHandoffRun(TENANT, pmThread);
    const { data, error } = await callRpc(pmThread, TENANT, childRun);
    expect(error).toBeNull();
    expect(typeof data).toBe("string");
    if (typeof data === "string") created.messageIds.push(data);
  });

  it("REJECTS a destination thread owned by a non-{operator,pm} agent (growth-lead)", async () => {
    const glThread = await makeThread(TENANT, "growth-lead");
    const childRun = await makeHandoffRun(TENANT, glThread);
    const { error } = await callRpc(glThread, TENANT, childRun);
    expect(error).not.toBeNull();
    expect(error?.code).toBe("42501");
  });

  it("REJECTS a cross-tenant thread (thread tenant != run tenant)", async () => {
    const otherThread = await makeThread(CROSS_TENANT, "pm");
    const childRun = await makeHandoffRun(TENANT, otherThread);
    const { error } = await callRpc(otherThread, TENANT, childRun);
    expect(error).not.toBeNull();
    expect(error?.code).toBe("42501");
  });

  it("REJECTS a non-handoff trigger run", async () => {
    const pmThread = await makeThread(TENANT, "pm");
    const childRun = await makeHandoffRun(TENANT, pmThread, "chat");
    const { error } = await callRpc(pmThread, TENANT, childRun);
    expect(error).not.toBeNull();
    expect(error?.code).toBe("42501");
  });

  it("REJECTS when payload.operator_thread_id != p_operator_thread_id", async () => {
    const pmThread = await makeThread(TENANT, "pm");
    const otherPmThread = await makeThread(TENANT, "pm");
    const childRun = await makeHandoffRun(TENANT, otherPmThread);
    const { error } = await callRpc(pmThread, TENANT, childRun);
    expect(error).not.toBeNull();
    expect(error?.code).toBe("42501");
  });

});
