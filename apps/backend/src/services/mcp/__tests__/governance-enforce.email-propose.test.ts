
import { beforeEach, describe, it, expect, vi } from "vitest";

vi.mock("@/services/agents/deepagent/engine", () => ({}));
vi.mock("@/services/settings", () => ({ getStringSetting: async () => "enforce" }));
const stop = vi.hoisted(() => ({ run: false, killed: false, reads: [] as string[] }));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    rpc: async () => ({ data: "approval", error: null }),
    from: (table: string) => {
      const eqs: string[] = [];
      const q = {
        select: () => q,
        eq: (col: string, v: unknown) => (eqs.push(`${col}=${String(v)}`), q),
        maybeSingle: async () => {
          stop.reads.push(`${table}:${eqs.join(",")}`);
          if (table === "agent_runs") return { data: { stop_requested: stop.run }, error: null };
          if (table === "tenant_agent_kill_switch") return { data: stop.killed ? { agent_slug: "email_marketing" } : null, error: null };
          return { data: null, error: null };
        },
      };
      return q;
    },
  }),
}));
vi.mock("../streamable-client", () => ({ advertisedReadToolNames: () => undefined, advertisedComposioWriteTool: () => null }));

import { governActionOrBlock } from "../governance-enforce";

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";

beforeEach(() => {
  stop.run = false;
  stop.killed = false;
  stop.reads = [];
});

describe("email__propose_campaign at the enforce-mode chokepoint", () => {
  it("passes: filing the card is the governance, nothing is sent", async () => {
    const emit = vi.fn(async () => "dec-1");
    const gate = await governActionOrBlock({ tenant_id: TENANT, run_id: "run-1", emit_decision: emit }, "email", "propose_campaign", {});
    expect(gate.block).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });

  it("passes on a run with no emit channel too, and the tool itself then refuses to file", async () => {
    const gate = await governActionOrBlock({ tenant_id: TENANT, run_id: "run-1" }, "email", "propose_campaign", {});
    expect(gate.block).toBe(false);
    const { callEmailTool } = await import("../internal/email");
    const out = await callEmailTool(TENANT, "propose_campaign", {
      route: "mailchimp",
      audience_id: "L1",
      variants: [{ subject: "Hi", preview_text: "p", title: "t", paragraphs: ["a"], button: { label: "Go", url: "https://acme.test" } }],
    }, { run_id: "run-1" });
    expect(out.ok).toBe(false);
    expect(JSON.parse(String(out.content)).error).toBe("email_campaign_propose_unavailable");
  });

  it("a stopped run: blocked at the chokepoint, nothing filed", async () => {
    stop.run = true;
    const emit = vi.fn(async () => "dec-1");
    const gate = await governActionOrBlock({ tenant_id: TENANT, run_id: "run-1", emit_decision: emit }, "email", "propose_campaign", {});
    expect(gate.block).toBe(true);
    if (gate.block) expect(JSON.parse(String(gate.result.content)).error).toBe("run_cancelled");
    expect(emit).not.toHaveBeenCalled();
    expect(stop.reads).toContain("agent_runs:id=run-1");
  });

  it("a killed agent: blocked at the chokepoint", async () => {
    stop.killed = true;
    const gate = await governActionOrBlock({ tenant_id: TENANT, run_id: "run-1", agent_slug: "email_marketing" }, "email", "propose_campaign", {});
    expect(gate.block).toBe(true);
    if (gate.block) expect(JSON.parse(String(gate.result.content)).error).toBe("run_cancelled");
    expect(stop.reads).toContain(`tenant_agent_kill_switch:tenant_id=${TENANT},agent_slug=email_marketing,override_state=hidden,source=staff`);
  });

  it("other ungoverned calls are unchanged: a stopped run does not block a read here", async () => {
    stop.run = true;
    const gate = await governActionOrBlock({ tenant_id: TENANT, run_id: "run-1" }, "email", "list_inbox", {});
    expect(gate.block).toBe(false);
  });

  it("email__send stays governed: no approval channel, blocked", async () => {
    const gate = await governActionOrBlock({ tenant_id: TENANT, run_id: "run-1" }, "email", "send", { to: "a@b.co", subject: "s", body: "b" });
    expect(gate.block).toBe(true);
    if (gate.block) expect(gate.result.content).toContain("approval_channel_unavailable");
  });

  it("email__send stays governed: with a channel it files its own card and does not run", async () => {
    const emit = vi.fn(async () => "dec-2");
    const gate = await governActionOrBlock(
      { tenant_id: TENANT, emit_decision: emit },
      "email",
      "send",
      { to: "customer@example.com", subject: "Hello", body: "Hi there" },
    );
    expect(gate.block).toBe(true);
  });
});
