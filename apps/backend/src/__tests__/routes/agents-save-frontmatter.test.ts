
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";
import {
  mergeEditableFrontmatter,
  FrontmatterValidationError,
  ALLOWED_MODELS,
  listFleetToolUniverse,
} from "../../services/agents/setup-schema";

const praxisCto = {
  model: ALLOWED_MODELS[0],
  manual_only: true,
  side_effects: true,
  decision_class: "engineer.ship-pr",
  requires_sandbox: true,
  runtime: "sdk",
  kill_switch: true,
  impact_classes: ["code"],
  output_envelope: "pr_proposal",
  tools: [],
  response_contract: "auto",
  recall_policy: "live_state_aware",
  cost_class: "expensive",
  setup: { rationale: "needs github", vault_keys: [], connectors: ["github"] },
};
const baseCto = {
  name: "engineer",
  description: "ships PRs",
  metadata: { praxis: praxisCto },
};
const sub = (overrides: Record<string, unknown>) => ({
  ...baseCto,
  metadata: { praxis: { ...praxisCto, ...overrides } },
});
const mp = (fm: Record<string, unknown>) =>
  (fm.metadata as { praxis: Record<string, unknown> }).praxis;

describe("mergeEditableFrontmatter — trust boundary", () => {
  it("REJECTS a posted decision_class change (money/autonomy floor)", () => {
    expect(() =>
      mergeEditableFrontmatter(baseCto, sub({ decision_class: "engineer.auto-ship-no-approval" })),
    ).toThrowError(FrontmatterValidationError);
    try {
      mergeEditableFrontmatter(baseCto, sub({ decision_class: "x.auto" }));
    } catch (e) {
      expect((e as FrontmatterValidationError).code).toBe("locked_field");
      expect((e as FrontmatterValidationError).field).toBe("decision_class");
    }
  });

  it("REJECTS flipping side_effects (money-path classification)", () => {
    expect(() => mergeEditableFrontmatter(baseCto, sub({ side_effects: false }))).toThrowError(
      /locked/i,
    );
  });

  it("REJECTS flipping requires_sandbox (sandbox-escape / security)", () => {
    let code = "";
    try {
      mergeEditableFrontmatter(baseCto, sub({ requires_sandbox: false }));
    } catch (e) {
      code = (e as FrontmatterValidationError).code;
    }
    expect(code).toBe("locked_field");
  });

  it("REJECTS editing the credential/setup block (no secret injection)", () => {
    let field = "";
    try {
      mergeEditableFrontmatter(
        baseCto,
        sub({
          setup: { rationale: "x", vault_keys: [{ key: "stolen", label: "x", input: "password", required: true }], connectors: [] },
        }),
      );
    } catch (e) {
      field = (e as FrontmatterValidationError).field;
    }
    expect(field).toBe("setup");
  });

  it("REJECTS an arbitrary unknown frontmatter key (no injection)", () => {
    let code = "";
    try {
      mergeEditableFrontmatter(baseCto, sub({ evil_runtime_flag: true }));
    } catch (e) {
      code = (e as FrontmatterValidationError).code;
    }
    expect(code).toBe("unknown_field");
  });

  it("REJECTS changing an envelope-coupled output_envelope", () => {
    let code = "";
    try {
      mergeEditableFrontmatter(baseCto, sub({ output_envelope: "digest" }));
    } catch (e) {
      code = (e as FrontmatterValidationError).code;
    }
    expect(code).toBe("envelope_coupled");
  });

  it("REJECTS a model outside the pricing allow-list", () => {
    expect(() =>
      mergeEditableFrontmatter(baseCto, sub({ model: "gpt-4o-super-cheap" })),
    ).toThrowError(/model must be one of/i);
  });

  it("REJECTS a tool slug not in the fleet registry", () => {
    expect(() =>
      mergeEditableFrontmatter(baseCto, sub({ tools: ["evil__exfiltrate_secrets"] })),
    ).toThrowError(/Unknown tool/i);
  });

  it("APPLIES legitimate editable edits + preserves locked fields verbatim", () => {
    const aTool = listFleetToolUniverse().find((t) => t.startsWith("github__")) ?? listFleetToolUniverse()[0];
    const out = mp(
      mergeEditableFrontmatter(baseCto, sub({ response_contract: "terse", cost_class: "standard", tools: [aTool] })),
    );
    expect(out.response_contract).toBe("terse");
    expect(out.cost_class).toBe("standard");
    expect(out.tools).toEqual([aTool]);
    expect(out.decision_class).toBe("engineer.ship-pr");
    expect(out.side_effects).toBe(true);
    expect(out.requires_sandbox).toBe(true);
    expect(out.kill_switch).toBe(true);
    expect((out.setup as { connectors: string[] }).connectors).toContain("github");
  });

  it("tolerates an idempotent round-trip of locked fields (UI re-posts base)", () => {
    expect(() => mergeEditableFrontmatter(baseCto, JSON.parse(JSON.stringify(baseCto)))).not.toThrow();
  });
});

const H = vi.hoisted(() => ({
  authReturn: { user_id: "u1", tenant_id: "t1", access_token: "tok" } as
    | { user_id: string; tenant_id: string; access_token: string }
    | null,
  baseFrontmatter: null as Record<string, unknown> | null,
  rpcCalls: [] as Array<{ fn: string; args: unknown }>,
}));

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async (_req: Request, res: Response) => {
    if (!H.authReturn) res.status(401).json({ error: { code: "unauthenticated" } });
    return H.authReturn;
  }),
}));

vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: vi.fn(() => ({
    from: vi.fn(() => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            order: () => ({
              limit: () => ({
                maybeSingle: () =>
                  Promise.resolve({
                    data: H.baseFrontmatter ? { frontmatter: H.baseFrontmatter } : null,
                    error: null,
                  }),
              }),
            }),
          }),
        }),
      }),
    })),
    rpc: vi.fn(async (fn: string, args: unknown) => {
      H.rpcCalls.push({ fn, args });
      return { data: 2, error: null };
    }),
  })),
}));

import { agentSave } from "../../routes/agents/save";

function mockRes() {
  const body: { status?: number; json?: unknown } = {};
  return {
    status: vi.fn(function (this: unknown, s: number) {
      body.status = s;
      return this;
    }),
    json: vi.fn(function (j: unknown) {
      body.json = j;
      return j;
    }),
    _body: body,
  } as unknown as Response & { _body: typeof body };
}

const req = (params: Record<string, string>, body: unknown): Request =>
  ({ params, body }) as unknown as Request;

beforeEach(() => {
  H.authReturn = { user_id: "u1", tenant_id: "t1", access_token: "tok" };
  H.baseFrontmatter = { ...baseCto };
  H.rpcCalls.length = 0;
});

describe("POST /api/agents/:slug/save — server-side trust boundary", () => {
  it("REJECTS a posted locked decision_class with 400 + NO RPC write", async () => {
    const r = mockRes();
    await agentSave(
      req(
        { slug: "engineer" },
        {
          body_markdown: "# body",
          frontmatter: sub({ decision_class: "engineer.auto-no-approval" }),
          status: "active",
        },
      ),
      r,
    );
    expect(r._body.status).toBe(400);
    expect((r._body.json as { error: { code: string } }).error.code).toBe("locked_field");
    expect(H.rpcCalls.length).toBe(0);
  });

  it("REJECTS a posted credential/setup blob with 400 + NO RPC write", async () => {
    const r = mockRes();
    await agentSave(
      req(
        { slug: "engineer" },
        {
          body_markdown: "# body",
          frontmatter: sub({
            setup: { rationale: "x", vault_keys: [{ key: "exfil", label: "x", input: "password", required: true }], connectors: [] },
          }),
          status: "active",
        },
      ),
      r,
    );
    expect(r._body.status).toBe(400);
    expect(H.rpcCalls.length).toBe(0);
  });

  it("ACCEPTS a legitimate editable edit + persists merged frontmatter via RPC", async () => {
    const r = mockRes();
    await agentSave(
      req(
        { slug: "engineer" },
        {
          body_markdown: "# body",
          frontmatter: sub({ response_contract: "terse" }),
          status: "draft",
        },
      ),
      r,
    );
    expect(r._body.status).toBeUndefined();
    expect(H.rpcCalls.length).toBe(1);
    const args = H.rpcCalls[0].args as { p_frontmatter: Record<string, unknown> };
    const praxis = mp(args.p_frontmatter);
    expect(praxis.response_contract).toBe("terse");
    expect(praxis.decision_class).toBe("engineer.ship-pr");
  });

  it("returns 409 not_forked_yet when no base version exists", async () => {
    H.baseFrontmatter = null;
    const r = mockRes();
    await agentSave(
      req({ slug: "engineer" }, { body_markdown: "# b", frontmatter: {}, status: "draft" }),
      r,
    );
    expect(r._body.status).toBe(409);
    expect(H.rpcCalls.length).toBe(0);
  });
});
