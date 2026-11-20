
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExpectedToolError } from "@/services/tools/types";

const getSecret = vi.fn();
vi.mock("@/services/secrets/vault", () => ({ getSecret: (...a: unknown[]) => getSecret(...a) }));

import {
  supabaseProjectInfoTool,
  supabaseListEdgeFunctionsTool,
  supabaseQueryLogsTool,
} from "../tools";
import { supabaseCreds } from "../_client";
import { SUPABASE_VAULT_KEYS, SUPABASE_MANAGEMENT_API_BASE } from "../keys";

const ctx = { tenant_id: "t-1", log: () => {} };

beforeEach(() => {
  getSecret.mockReset();
  vi.restoreAllMocks();
});

describe("supabase_query_logs read-only guard", () => {
  for (const sql of [
    "DELETE FROM logs",
    "insert into logs values (1)",
    "SELECT 1; DROP TABLE logs",
    "  Update logs SET event_message = 'x'",
    "TRUNCATE logs",
  ]) {
    it(`rejects: ${sql.slice(0, 32)}`, async () => {
      await expect(supabaseQueryLogsTool.execute(ctx, { sql })).rejects.toMatchObject({
        code: "supabase_query_not_read_only",
      });
    });
  }

  it("does not reject an ordinary SELECT before it reaches the credential lookup", async () => {
    getSecret.mockResolvedValue(null);
    await expect(
      supabaseQueryLogsTool.execute(ctx, {
        sql: "SELECT timestamp, event_message FROM logs WHERE source_name = 'edge_logs' LIMIT 10",
      }),
    ).rejects.toMatchObject({ code: "supabase_not_connected" });
  });
});

describe("supabaseCreds fails closed", () => {
  it("throws supabase_not_connected when no secrets exist", async () => {
    getSecret.mockResolvedValue(null);
    const err = await supabaseCreds("t-1").catch((e) => e);
    expect(err).toBeInstanceOf(ExpectedToolError);
    expect(err.code).toBe("supabase_not_connected");
    expect(err.message).toMatch(/Settings/);
  });

  it("throws supabase_not_connected when only one of the two secrets exists", async () => {
    getSecret.mockImplementation(async (_t: string, key: string) =>
      key === SUPABASE_VAULT_KEYS.access_token ? "sbp_test" : null,
    );
    const err = await supabaseCreds("t-1").catch((e) => e);
    expect(err).toBeInstanceOf(ExpectedToolError);
    expect(err.code).toBe("supabase_not_connected");
  });

  it("resolves both secrets from Vault when both are present", async () => {
    getSecret.mockImplementation(async (_t: string, key: string) =>
      key === SUPABASE_VAULT_KEYS.access_token ? "sbp_test" : "abcdefghijklmnopqrst",
    );
    const creds = await supabaseCreds("t-1");
    expect(creds.access_token).toBe("sbp_test");
    expect(creds.project_ref).toBe("abcdefghijklmnopqrst");
  });
});

describe("project_info and list_edge_functions pin the stored project_ref", () => {
  beforeEach(() => {
    getSecret.mockImplementation(async (_t: string, key: string) =>
      key === SUPABASE_VAULT_KEYS.access_token ? "sbp_test" : "myproject",
    );
  });

  it("supabase_project_info calls /projects/{stored_ref}, never a caller-supplied ref", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ ref: "myproject", name: "My Project", region: "us-east-1", status: "ACTIVE_HEALTHY" }),
        { status: 200 },
      ),
    );
    const out = await supabaseProjectInfoTool.execute(ctx, {});
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const calledUrl = String(fetchSpy.mock.calls[0]![0]);
    expect(calledUrl).toBe(`${SUPABASE_MANAGEMENT_API_BASE}/projects/myproject`);
    expect(out).toMatchObject({ ref: "myproject", status: "ACTIVE_HEALTHY" });
  });

  it("supabase_list_edge_functions calls /projects/{stored_ref}/functions", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify([{ slug: "hello", name: "hello", status: "ACTIVE", version: 3 }]), {
        status: 200,
      }),
    );
    const out = await supabaseListEdgeFunctionsTool.execute(ctx, {});
    const calledUrl = String(fetchSpy.mock.calls[0]![0]);
    expect(calledUrl).toBe(`${SUPABASE_MANAGEMENT_API_BASE}/projects/myproject/functions`);
    expect(out).toMatchObject({ count: 1 });
  });

  it("maps a 401 from the Management API to supabase_token_rejected without echoing the body", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ message: "invalid api key: sbp_test" }), { status: 401 }),
    );
    const err = (await supabaseProjectInfoTool.execute(ctx, {}).catch((e) => e)) as ExpectedToolError;
    expect(err).toBeInstanceOf(ExpectedToolError);
    expect(err.code).toBe("supabase_token_rejected");
    expect(err.message).not.toMatch(/sbp_test/);
  });
});
