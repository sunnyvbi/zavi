
import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runVariants, runIdRange, type RunVariantsDeps } from "../run-variants";
import { LAB_DENY_CODE } from "../lab-gate";
import { makeLabGuardedFetch } from "../lab-db-guard";
import type { AgentContext, DispatcherResult } from "../../types";

const T1 = "73db45ff-457e-4541-bc8f-bdb625390204";
const T2 = "11c9df69-0000-4000-8000-000000000000";

type Row = Record<string, unknown>;

function fakeSb(tables: Record<string, Row[]>) {
  const calls: Array<{ table: string; op: string }> = [];
  const sb = {
    from(table: string) {
      let rows = [...(tables[table] ?? [])];
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (col: string, v: unknown) => {
          rows = rows.filter((r) => (col.includes("->>") ? true : r[col] === v));
          return chain;
        },
        in: (col: string, vs: unknown[]) => {
          rows = rows.filter((r) => vs.includes(r[col]));
          return chain;
        },
        gte: (col: string, v: string) => {
          rows = rows.filter((r) => String(r[col]) >= v);
          return chain;
        },
        is: (col: string, v: unknown) => {
          const key = col.includes("->>") ? col.split("->>") : null;
          rows = rows.filter((r) => (key ? ((r[key[0]] as Record<string, unknown> | undefined)?.[key[1]] ?? null) : r[col]) === v);
          return chain;
        },
        lt: (col: string, v: string) => {
          rows = rows.filter((r) => String(r[col]) < v);
          return chain;
        },
        lte: (col: string, v: string) => {
          rows = rows.filter((r) => String(r[col]) <= v);
          return chain;
        },
        order: (col: string, o?: { ascending?: boolean }) => {
          rows = [...rows].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (o?.ascending === false ? -1 : 1));
          return chain;
        },
        limit: (n: number) => Promise.resolve({ data: rows.slice(0, n), error: null }),
        insert: () => {
          calls.push({ table, op: "insert" });
          return Promise.resolve({ error: null });
        },
        upsert: () => {
          calls.push({ table, op: "upsert" });
          return Promise.resolve({ error: null });
        },
        update: () => {
          calls.push({ table, op: "update" });
          return chain;
        },
      };
      return chain;
    },
    rpc: () => {
      calls.push({ table: "rpc", op: "rpc" });
      return Promise.resolve({ data: null, error: null });
    },
  };
  return { sb: sb as unknown as SupabaseClient, calls };
}

const variantRows = [
  { slug: "v1", label: "V1", config: { effort: "low" } },
  { slug: "v2", label: "V2", config: { tools: { disable: ["github__search_code"] } } },
  { slug: "bad", label: "Bad", config: { max_turn: 3 } },
  { slug: "nomem", label: "No memory", config: { memory: "off" } },
  { slug: "nofile", label: "Missing prompt", config: { prompt: { agent_file: "missing" } } },
  { slug: "lean", label: "Lean prompt", config: { prompt: { agent_file: "lean" } } },
  { slug: "rv", label: "Recipe variant", config: { prompt: { recipe_file: "tight" } } },
];

const runRows = [
  {
    id: "d8055692-1111-4222-8333-444455556666",
    tenant_id: T1,
    agent_slug: "operator",
    trigger: "slack",
    payload: { slack: { text: "When I click on the button why it's opening localhost?", team_id: "TX", images: [{ id: "F1" }] } },
  },
  {
    id: "e0000000-1111-4222-8333-444455556666",
    tenant_id: T2,
    agent_slug: "operator",
    trigger: "slack",
    payload: { slack: { text: "other tenant" } },
  },
  { id: "ca000001-1111-4222-8333-444455556666", tenant_id: T1, agent_slug: "cgo", trigger: "chat", payload: { thread_id: "t1", user_message_id: "m-1" } },
  { id: "ca000002-1111-4222-8333-444455556666", tenant_id: T1, agent_slug: "cgo", trigger: "chat", payload: { thread_id: "t1", user_message_id: "m-2" } },
  { id: "ca000003-1111-4222-8333-444455556666", tenant_id: T1, agent_slug: "cgo", trigger: "chat", payload: { thread_id: "t3", user_message_id: "m-3" } },
  { id: "ca000004-1111-4222-8333-444455556666", tenant_id: T1, agent_slug: "cgo", trigger: "chat", payload: { thread_id: "t1", user_message_id: "m-1", video_paths: ["v.mp4"] } },
  {
    id: "c4a00000-1111-4222-8333-444455556666",
    tenant_id: T1,
    agent_slug: "seo",
    trigger: "channel_recipe",
    payload: { channel_slug: "seo", recipe_body: "OLD RECIPE FROM ENQUEUE TIME", router: [{ id: "old" }], inputs: ["old"], artifact: "old", min_evidence: 9 },
  },
];

const threadMessages = [
  { id: "m-0a", tenant_id: T1, thread_id: "t1", created_at: "2026-10-01T10:00:00Z", sender_role: "user", body: "What is our budget?" },
  { id: "m-0b", tenant_id: T1, thread_id: "t1", created_at: "2026-10-01T10:01:00Z", sender_role: "assistant", body: "It is $25,000 for October." },
  { id: "m-0c", tenant_id: T1, thread_id: "t1", created_at: "2026-10-01T10:01:10Z", sender_role: "system", body: "SYSTEM internal note" },
  { id: "m-old", tenant_id: T1, thread_id: "t1", created_at: "2026-10-01T10:00:30Z", sender_role: "user", body: "OLD budget is $2k", meta: { superseded_by: "m-0a" } },
  { id: "m-x", tenant_id: T2, thread_id: "t1", created_at: "2026-10-01T10:01:30Z", sender_role: "user", body: "LEAK other tenant" },
  { id: "m-1", tenant_id: T1, thread_id: "t1", created_at: "2026-10-01T10:02:00Z", sender_role: "user", body: "Why did signups drop last week?" },
  { id: "m-2", tenant_id: T2, thread_id: "t2", created_at: "2026-10-01T10:00:00Z", sender_role: "user", body: "other tenant's message" },
  { id: "m-3", tenant_id: T1, thread_id: "t3", created_at: "2026-10-01T10:00:00Z", sender_role: "user", body: "what does this chart show?", attachments: [{ path: "x.png" }] },
];

function result(over: Partial<DispatcherResult> = {}): DispatcherResult {
  return {
    output_text: "answer",
    parsed: null,
    parse_ok: true,
    raw_response_text: "answer",
    prompt_snapshot: "",
    usage: { input_tokens: 10, output_tokens: 5, cost_usd: 0.01 },
    tool_calls: [
      { name: "github__read_file", input_preview: '{"path":"weeklyGuestEmail/approval.ts"}', output_preview: "{}", ms: 3, status: "ok" },
      { name: "praxis__handoff", input_preview: "{}", output_preview: "", ms: 0, status: "tool_error", code: LAB_DENY_CODE },
      {
        name: "mcp__server__slack__post_message",
        input_preview: "{}",
        output_preview: "blocked in variants lab (read-only). Not executed",
        ms: 0,
        status: "tool_error",
      },
    ],
    ...over,
  };
}

function makeDeps(over: Partial<RunVariantsDeps> = {}) {
  const { sb, calls } = fakeSb({ agent_engine_variants: variantRows, agent_runs: runRows, agent_thread_messages: threadMessages });
  const seen: AgentContext[] = [];
  const enqueue = vi.fn();
  let n = 0;
  const deps: RunVariantsDeps = {
    sb,
    buildContext: vi.fn(async (claim) => ({ tenant_id: claim.tenant_id, runId: claim.id }) as unknown as AgentContext),
    makeDraftCtx: (ctx) => ({ ...ctx, draft_mode: true }),
    runDispatch: vi.fn(async (ctx: AgentContext) => {
      seen.push(ctx);
      return result();
    }),
    buildCgoFreshPayload: vi.fn(async () => ({ stage: "own_goals" })),
    cgoNoteReplyMessage: (note, reply) => `${note}|${reply}`,
    decodeOutboxBody: (b) => ({ text: b }),
    noteKeyOfOutboxRow: () => null,
    parseGoalMoves: () => ({ ok: false, reason: "no block" }),
    newRunId: () => `00000000-0000-4000-8000-00000000000${n++}`,
    promptFileExists: (_a, f) => f !== "missing",
    ...over,
  };
  return { deps, seen, calls, enqueue };
}

const text = { kind: "operator_text" as const, text: "why localhost?" };

describe("runVariants", () => {
  it("runs every variant in parallel with its own override, lab flag and draft mode", async () => {
    const { deps, seen } = makeDeps();
    const r = await runVariants({ tenantId: T1, agentSlug: "operator", input: text, variantSlugs: ["default", "v1", "v2"], deps });
    expect(r.results.map((x) => x.ok)).toEqual([true, true, true]);
    expect(seen).toHaveLength(3);
    for (const c of seen) {
      expect(c.variants_lab).toBe(true);
      expect(c.draft_mode).toBe(true);
    }
    expect(seen.map((c) => c.variant_override?.slug ?? null).sort()).toEqual([null, "v1", "v2"].sort());
    expect(seen.find((c) => c.variant_override?.slug === "v2")?.variant_override?.config.tools?.disable).toEqual([
      "github__search_code",
    ]);
    expect(new Set(seen.map((c) => c.runId)).size).toBe(3);
  });

  it("a memory-off variant's payload carries memory_mode off into buildContext; others do not", async () => {
    const { deps } = makeDeps();
    await runVariants({ tenantId: T1, agentSlug: "operator", input: text, variantSlugs: ["default", "nomem"], deps });
    const claims = (deps.buildContext as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    const byMode = claims.map((c) => (c.payload as { memory_mode?: string }).memory_mode);
    expect(byMode).toEqual([undefined, "off"]);
  });

  it("a replayed payload's own memory_mode never leaks into memory-on columns", async () => {
    const { deps } = makeDeps();
    const src = runRows[0].payload as Record<string, unknown>;
    src.memory_mode = "off";
    try {
      await runVariants({ tenantId: T1, agentSlug: "operator", input: { kind: "past_run", runId: "d8055692" }, variantSlugs: ["default", "nomem"], deps });
    } finally {
      delete src.memory_mode;
    }
    const claims = (deps.buildContext as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(claims.map((c) => (c.payload as { memory_mode?: string }).memory_mode)).toEqual([undefined, "off"]);
  });

  it("a variant whose prompt file is missing errors in its column and never runs", async () => {
    const { deps, seen } = makeDeps();
    const r = await runVariants({ tenantId: T1, agentSlug: "operator", input: text, variantSlugs: ["default", "nofile"], deps });
    expect(r.results[1]).toMatchObject({ slug: "nofile", ok: false, error: "prompt file agent.missing.md not found" });
    expect(r.results[0].ok).toBe(true);
    expect(seen.map((c) => c.variant_override?.slug ?? null)).toEqual([null]);
  });

  it("marks a column 'ran as default' when the dispatcher fell back", async () => {
    const { deps } = makeDeps({
      runDispatch: vi.fn(async (ctx: AgentContext) => {
        ctx.resolved_variant = { slug: null, config: {} };
        return result();
      }),
    });
    const r = await runVariants({ tenantId: T1, agentSlug: "operator", input: text, variantSlugs: ["lean"], deps });
    expect(r.results[0]).toMatchObject({ ok: true, resolved_slug: null, ran_as_default: true });
  });

  it("a variant that ran as itself is not marked", async () => {
    const { deps } = makeDeps({
      runDispatch: vi.fn(async (ctx: AgentContext) => {
        ctx.resolved_variant = ctx.variant_override;
        return result();
      }),
    });
    const r = await runVariants({ tenantId: T1, agentSlug: "operator", input: text, variantSlugs: ["default", "lean"], deps });
    expect(r.results[0]).toMatchObject({ resolved_slug: null, ran_as_default: false });
    expect(r.results[1]).toMatchObject({ resolved_slug: "lean", ran_as_default: false });
  });

  it("each tool call keeps the whole bounded trace the run saw, truncation marker included, and is_error", async () => {
    const long = "x".repeat(8192) + "…[truncated 3808 bytes]";
    const { deps } = makeDeps({
      runDispatch: vi.fn(async () =>
        result({
          tool_calls: [
            { name: "github__read_file", input_preview: "{}", output_preview: long, ms: 1, status: "ok" },
            { name: "github__grep", input_preview: "{}", output_preview: '{"error":"rate_limited"}', ms: 1, status: "tool_error", code: "rate_limited" },
          ],
        }),
      ),
    });
    const r = await runVariants({ tenantId: T1, agentSlug: "operator", input: text, variantSlugs: ["default"], deps });
    const [a, b] = r.results[0].tool_calls!;
    expect(a.output_preview).toBe(long);
    expect(a.is_error).toBe(false);
    expect(b).toMatchObject({ output_preview: '{"error":"rate_limited"}', is_error: true, status: "error" });
  });

  it("each column lists the prod DB writes the guard refused during ITS run", async () => {
    const PROD = "https://wmycgyjsenvgtczlupoe.supabase.co";
    const guarded = makeLabGuardedFetch({
      supabaseUrl: PROD,
      baseFetch: (async () => new Response("[]")) as unknown as typeof fetch,
      onBlocked: () => {},
    });
    const { deps } = makeDeps({
      runDispatch: vi.fn(async (ctx: AgentContext) => {
        await guarded(`${PROD}/rest/v1/tenants?select=id`);
        if (ctx.variant_override?.slug === "v1") {
          await guarded(`${PROD}/rest/v1/tenant_mcp_servers?x=1`, { method: "PATCH" }).catch(() => {});
        }
        return result();
      }),
    });
    const r = await runVariants({ tenantId: T1, agentSlug: "operator", input: text, variantSlugs: ["default", "v1"], deps });
    expect(r.results[0].blocked_db_writes).toBeUndefined();
    expect(r.results[1].blocked_db_writes).toEqual(["patch:tenant_mcp_servers"]);
  });

  it("reports tools, blocked writes and stats per column", async () => {
    const { deps } = makeDeps();
    const r = await runVariants({ tenantId: T1, agentSlug: "operator", input: text, variantSlugs: ["v1"], deps });
    const col = r.results[0];
    expect(col.tool_calls?.[0]).toMatchObject({ name: "github__read_file", status: "ok" });
    expect(col.tool_calls?.[0].input_preview).toContain("weeklyGuestEmail/approval.ts");
    expect(col.blocked).toEqual(["praxis__handoff", "mcp__server__slack__post_message"]);
    expect(col).toMatchObject({ cost_usd: 0.01, tokens: { input: 10, output: 5 } });
  });

  it("one variant failing leaves the others", async () => {
    const { deps } = makeDeps({
      runDispatch: vi.fn(async (ctx: AgentContext) => {
        if (ctx.variant_override?.slug === "v1") throw new Error("boom");
        return result();
      }),
    });
    const r = await runVariants({ tenantId: T1, agentSlug: "operator", input: text, variantSlugs: ["default", "v1"], deps });
    expect(r.results[0].ok).toBe(true);
    expect(r.results[1]).toMatchObject({ ok: false, error: "boom", slug: "v1" });
  });

  it("a variant that times out shows only in its column", async () => {
    const { deps } = makeDeps({
      timeoutMs: 20,
      runDispatch: vi.fn((ctx: AgentContext) =>
        ctx.variant_override?.slug === "v1" ? new Promise<DispatcherResult>(() => {}) : Promise.resolve(result()),
      ),
    });
    const r = await runVariants({ tenantId: T1, agentSlug: "operator", input: text, variantSlugs: ["default", "v1"], deps });
    expect(r.results[0].ok).toBe(true);
    expect(r.results[1].error).toMatch(/timed out/);
  });

  it("an invalid variant config errors in its column only", async () => {
    const { deps } = makeDeps();
    const r = await runVariants({ tenantId: T1, agentSlug: "operator", input: text, variantSlugs: ["default", "bad"], deps });
    expect(r.results[0].ok).toBe(true);
    expect(r.results[1]).toMatchObject({ ok: false });
    expect(r.results[1].error).toMatch(/invalid config/);
  });

  it("rejects an unknown slug and more than 6 variations before running anything", async () => {
    const { deps } = makeDeps();
    await expect(
      runVariants({ tenantId: T1, agentSlug: "operator", input: text, variantSlugs: ["nope"], deps }),
    ).rejects.toThrow(/unknown variation: nope/);
    await expect(
      runVariants({ tenantId: T1, agentSlug: "operator", input: text, variantSlugs: ["a", "b", "c", "d", "e", "f", "g"], deps }),
    ).rejects.toThrow(/at most 6/);
    expect(deps.runDispatch).not.toHaveBeenCalled();
  });

  it("writes nothing: no insert, upsert, update or rpc on the client", async () => {
    const { deps, calls } = makeDeps();
    await runVariants({ tenantId: T1, agentSlug: "operator", input: text, variantSlugs: ["default", "v1"], deps });
    expect(calls).toEqual([]);
  });

  it("typed question is Slack-shaped with no team_id, images ride on ctx", async () => {
    const { deps, seen } = makeDeps();
    const runDispatch = deps.runDispatch as ReturnType<typeof vi.fn>;
    await runVariants({
      tenantId: T1,
      agentSlug: "operator",
      input: { kind: "operator_text", text: "hi", images: [{ mime: "image/png", base64: "AAAA" }] },
      variantSlugs: ["default"],
      deps,
    });
    const payload = runDispatch.mock.calls[0][1] as { slack: Record<string, unknown> };
    expect(payload.slack).toEqual({ text: "hi" });
    expect(seen[0].lab_user_images).toEqual([{ mime: "image/png", base64: "AAAA" }]);
    const claim = (deps.buildContext as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(claim.trigger).toBe("slack");
  });

  it("rejects a non-image upload", async () => {
    const { deps } = makeDeps();
    await expect(
      runVariants({
        tenantId: T1,
        agentSlug: "operator",
        input: { kind: "operator_text", text: "hi", images: [{ mime: "text/html", base64: "AAAA" }] },
        variantSlugs: ["default"],
        deps,
      }),
    ).rejects.toThrow(/unsupported image type/);
  });

  it("replays run d8055692 by short id: same question, same payload and images", async () => {
    const { deps } = makeDeps();
    const runDispatch = deps.runDispatch as ReturnType<typeof vi.fn>;
    const r = await runVariants({ tenantId: T1, agentSlug: "operator", input: { kind: "past_run", runId: "d8055692" }, variantSlugs: ["default"], deps });
    expect(r.input).toMatchObject({ source_run_id: runRows[0].id, text: "When I click on the button why it's opening localhost?" });
    expect(runDispatch.mock.calls[0][1]).toEqual(runRows[0].payload);
    const claim = (deps.buildContext as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(claim.trigger).toBe("slack");
    expect(claim.id).not.toBe(runRows[0].id);
  });

  it("a past run of another agent is refused, not replayed through the selected one", async () => {
    const { deps } = makeDeps();
    await expect(
      runVariants({ tenantId: T1, agentSlug: "cgo", input: { kind: "past_run", runId: "d8055692" }, variantSlugs: ["default"], deps }),
    ).rejects.toThrow(/belongs to operator, not cgo/);
  });

  it("a past run of another tenant is not found", async () => {
    const { deps } = makeDeps();
    await expect(
      runVariants({ tenantId: T1, agentSlug: "operator", input: { kind: "past_run", runId: runRows[1].id }, variantSlugs: ["default"], deps }),
    ).rejects.toThrow(/run not found/);
    expect(deps.runDispatch).not.toHaveBeenCalled();
  });

  it("a garbage run id is not found", async () => {
    const { deps } = makeDeps();
    await expect(
      runVariants({ tenantId: T1, agentSlug: "operator", input: { kind: "past_run", runId: "zz" }, variantSlugs: ["default"], deps }),
    ).rejects.toThrow(/run not found/);
  });

  it("cgo inputs are refused for another agent", async () => {
    const { deps } = makeDeps();
    await expect(
      runVariants({ tenantId: T1, agentSlug: "operator", input: { kind: "cgo_fresh" }, variantSlugs: ["default"], deps }),
    ).rejects.toThrow(/cgo input/);
    expect(deps.buildCgoFreshPayload).not.toHaveBeenCalled();
  });

  it("cgo columns carry the parsed moves, never applied", async () => {
    const { deps } = makeDeps({ parseGoalMoves: () => ({ ok: true, value: { moves: [1] } }) });
    const r = await runVariants({ tenantId: T1, agentSlug: "cgo", input: { kind: "cgo_fresh" }, variantSlugs: ["default"], deps });
    expect(r.results[0].moves).toEqual({ moves: [1] });
  });

  it("cgo columns list what the live number gate would refuse, using that variant's own run id", async () => {
    const gateMoves = vi.fn((_runId: string, _moves: unknown) => ["Work for meta_ads: unsourced 192"]);
    const { deps } = makeDeps({ parseGoalMoves: () => ({ ok: true, value: { moves: [1] } }), gateMoves, newRunId: () => "run-x" });
    const r = await runVariants({ tenantId: T1, agentSlug: "cgo", input: { kind: "cgo_fresh" }, variantSlugs: ["default"], deps });
    expect(gateMoves).toHaveBeenCalledWith("run-x", { moves: [1] });
    expect(r.results[0].moves_refused).toEqual(["Work for meta_ads: unsourced 192"]);
  });

  it("each column keeps the prompt the run saw, so the judge can check injected context", async () => {
    const { deps } = makeDeps({
      runDispatch: vi.fn(async () => result({ prompt_snapshot: "--- system ---\nThis month: $5,439.06 spent" })),
    });
    const r = await runVariants({ tenantId: T1, agentSlug: "operator", input: text, variantSlugs: ["default"], deps });
    expect(r.results[0].prompt_snapshot).toContain("$5,439.06");
  });
});

describe("runIdRange", () => {
  it("expands a prefix to a uuid range", () => {
    expect(runIdRange("d8055692")).toEqual({
      low: "d8055692-0000-0000-0000-000000000000",
      high: "d8055692-ffff-ffff-ffff-ffffffffffff",
    });
  });
  it("rejects short or non-hex input", () => {
    expect(runIdRange("d805")).toBeNull();
    expect(runIdRange("'; drop")).toBeNull();
  });

  it("a replayed channel run runs TODAY's recipe (or the variant's file), never the frozen copy", async () => {
    const loadRecipe = vi.fn((slug: string, file?: string) => ({
      body: `RECIPE ${slug} ${file ?? "main"}`,
      meta: { router: [{ id: file ?? "main" }], inputs: ["now"], artifact: "audit", min_evidence: 2 },
    })) as unknown as RunVariantsDeps["loadRecipe"];
    const { deps } = makeDeps({ loadRecipe });
    const r = await runVariants({ tenantId: T1, agentSlug: "seo", input: { kind: "past_run", runId: "c4a00000" }, variantSlugs: ["default", "rv"], deps });
    expect(r.results.map((x) => x.ok)).toEqual([true, true]);
    const payloads = (deps.buildContext as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0].payload as Record<string, unknown>);
    expect(payloads.map((p) => p.recipe_body)).toEqual(["RECIPE seo main", "RECIPE seo tight"]);
    expect(payloads[1]).toMatchObject({ router: [{ id: "tight" }], inputs: ["now"], artifact: "audit", min_evidence: 2, channel_slug: "seo" });
    expect(JSON.stringify(payloads)).not.toContain("OLD RECIPE");
  });

  it("a recipe variant on a non-channel input errors in its column only", async () => {
    const { deps } = makeDeps();
    const r = await runVariants({ tenantId: T1, agentSlug: "operator", input: text, variantSlugs: ["default", "rv"], deps });
    expect(r.results[0].ok).toBe(true);
    expect(r.results[1]).toMatchObject({ slug: "rv", ok: false, error: "recipe_file only applies to a replayed channel run" });
  });

  it("a missing recipe variant file errors in its column only", async () => {
    const loadRecipe = vi.fn((_s: string, file?: string) => {
      if (file) throw new Error("channel recipe not found: seo");
      return { body: "ok", meta: { router: [], inputs: [], artifact: "a", min_evidence: 1 } };
    }) as unknown as RunVariantsDeps["loadRecipe"];
    const { deps } = makeDeps({ loadRecipe });
    const r = await runVariants({ tenantId: T1, agentSlug: "seo", input: { kind: "past_run", runId: "c4a00000" }, variantSlugs: ["default", "rv"], deps });
    expect(r.results[0].ok).toBe(true);
    expect(r.results[1]).toMatchObject({ ok: false, error: "recipe: channel recipe not found: seo" });
  });

  it("a channel replay returns what the run would have filed, for the judge", async () => {
    const loadRecipe = vi.fn(() => ({ body: "r", meta: { router: [], inputs: [], artifact: "a", min_evidence: 1 } })) as unknown as RunVariantsDeps["loadRecipe"];
    const cards = { actions: [{ title: "Redirect /old to /", why: "duplicate title" }] };
    const { deps } = makeDeps({ loadRecipe, runDispatch: vi.fn(async () => result({ parsed: cards })) });
    const r = await runVariants({ tenantId: T1, agentSlug: "seo", input: { kind: "past_run", runId: "c4a00000" }, variantSlugs: ["default"], deps });
    expect(r.results[0]).toMatchObject({ ok: true, would_file: cards });
  });

  describe("channel cards", () => {
    const loadRecipe = vi.fn(() => ({ body: "r", meta: { router: [], inputs: [], artifact: "a", min_evidence: 1 } })) as unknown as RunVariantsDeps["loadRecipe"];
    const past = { kind: "past_run" as const, runId: "c4a00000" };
    const panel = { store: "channel_actions" as const, cards: [], more: 0, retired: [], displaced: [], open_before: 0 };

    it("a column whose output did not parse says so, and asks for no cards", async () => {
      const channelCards = vi.fn();
      const { deps } = makeDeps({ loadRecipe, channelCards, runDispatch: vi.fn(async () => result({ parse_ok: false, parse_error: "no JSON block" })) });
      const r = await runVariants({ tenantId: T1, agentSlug: "seo", input: past, variantSlugs: ["default"], deps });
      expect(r.results[0]).toMatchObject({ ok: true, parse_ok: false, parse_error: "no JSON block", no_cards_reason: "parse_failed" });
      expect(channelCards).not.toHaveBeenCalled();
    });

    it("a suppressed run shows the reason the gate gave", async () => {
      const { deps } = makeDeps({
        loadRecipe,
        runDispatch: vi.fn(async () => result({ parsed: null, side_effect: { kind: "refused", reason: "publish gate: no evidence" } })),
      });
      const r = await runVariants({ tenantId: T1, agentSlug: "seo", input: past, variantSlugs: ["default"], deps });
      expect(r.results[0].no_cards_reason).toBe("suppressed: publish gate: no evidence");
    });

    it("each column asks for its own cards with its own run id and the replayed run", async () => {
      const env = { steps: [{ title: "x" }] };
      const channelCards = vi.fn(async (_a: unknown) => ({ ok: true as const, value: panel }));
      const { deps } = makeDeps({ loadRecipe, channelCards, runDispatch: vi.fn(async () => result({ parsed: env })) });
      const r = await runVariants({ tenantId: T1, agentSlug: "seo", input: past, variantSlugs: ["default", "rv"], deps });
      expect(r.results.map((x) => x.cards)).toEqual([panel, panel]);
      const args = channelCards.mock.calls.map((c) => c[0] as Record<string, unknown>);
      expect(new Set(args.map((a) => a.runId)).size).toBe(2);
      expect(args[0]).toMatchObject({ tenantId: T1, channelSlug: "seo", sourceRunId: "c4a00000-1111-4222-8333-444455556666", envelope: env });
    });

    it("a card step failure is the column's reason, not an error", async () => {
      const channelCards = vi.fn(async () => ({ ok: false as const, reason: "lab_store_out_of_date: lab.channel_actions is missing" }));
      const { deps } = makeDeps({ loadRecipe, channelCards, runDispatch: vi.fn(async () => result({ parsed: { steps: [] } })) });
      const r = await runVariants({ tenantId: T1, agentSlug: "seo", input: past, variantSlugs: ["default"], deps });
      expect(r.results[0]).toMatchObject({ ok: true, no_cards_reason: "lab_store_out_of_date: lab.channel_actions is missing" });
    });

    it("channel_fresh starts a channel run with no past run, on today's recipe and the engine's payload extras", async () => {
      const channelCards = vi.fn(async (_a: unknown) => ({ ok: true as const, value: panel }));
      const buildChannelFreshPayload = vi.fn(async () => ({ pending_proposals: [{ id: "p1" }] }));
      const { deps } = makeDeps({ loadRecipe, channelCards, buildChannelFreshPayload, runDispatch: vi.fn(async () => result({ parsed: { steps: [{ title: "x" }] } })) });
      const r = await runVariants({ tenantId: T1, agentSlug: "meta_ads", input: { kind: "channel_fresh" }, variantSlugs: ["default"], deps });
      expect(r.results[0]).toMatchObject({ ok: true, cards: panel });
      expect(buildChannelFreshPayload).toHaveBeenCalledWith(T1, "meta_ads");
      const claim = (deps.buildContext as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(claim).toMatchObject({ trigger: "channel_recipe", agent_slug: "meta_ads" });
      expect(claim.payload).toMatchObject({ channel_slug: "meta_ads", recipe_body: "r", pending_proposals: [{ id: "p1" }] });
      const seed = (channelCards.mock.calls[0][0] as { sourceRunId: string }).sourceRunId;
      expect(runRows.find((x) => x.id === seed)?.tenant_id).toBe(T1);
    });

    it("channel_fresh is refused for operator and cgo", async () => {
      const { deps } = makeDeps({ buildChannelFreshPayload: vi.fn(async () => ({})) });
      await expect(
        runVariants({ tenantId: T1, agentSlug: "operator", input: { kind: "channel_fresh" }, variantSlugs: ["default"], deps }),
      ).rejects.toThrow(/needs a channel agent/);
      expect(deps.runDispatch).not.toHaveBeenCalled();
    });

    it("reports the model, effort and stop reason that actually ran, and the scrubbed output when it differs", async () => {
      const { deps } = makeDeps({
        loadRecipe,
        channelCards: vi.fn(async (_a: unknown) => ({ ok: true as const, value: panel })),
        scrubOutput: (t) => t.replace("SECRET", "[removed]"),
        runDispatch: vi.fn(async (ctx: AgentContext) => {
          ctx.lab_engine = { model: "claude-sonnet-5-5", effort: "xhigh" };
          return result({ output_text: "the SECRET plan", parsed: { steps: [{ title: "x" }] }, stop_reason: "end_turn", side_effect: { kind: "refused", reason: "gate held it" } });
        }),
      });
      const r = await runVariants({ tenantId: T1, agentSlug: "seo", input: past, variantSlugs: ["default"], deps });
      expect(r.results[0]).toMatchObject({
        model: "claude-sonnet-5-5",
        effort: "xhigh",
        stop_reason: "end_turn",
        side_effect: { kind: "refused", reason: "gate held it" },
        output_text: "the SECRET plan",
        visible_text: "the [removed] plan",
      });
    });

    it("a column past its time limit is aborted, not left running", async () => {
      let signal: AbortSignal | undefined;
      const { deps } = makeDeps({
        loadRecipe,
        timeoutMs: 20,
        runDispatch: vi.fn((ctx: AgentContext) => {
          signal = ctx.lab_abort;
          return new Promise<DispatcherResult>(() => {});
        }),
      });
      const r = await runVariants({ tenantId: T1, agentSlug: "seo", input: past, variantSlugs: ["default"], deps });
      expect(r.results[0]).toMatchObject({ ok: false });
      expect(r.results[0].error).toMatch(/timed out/);
      expect(signal?.aborted).toBe(true);
    });

    it("says when production would have refused the run for the credit cap, and still runs the columns", async () => {
      const { deps } = makeDeps({
        loadRecipe,
        channelCards: vi.fn(async (_a: unknown) => ({ ok: true as const, value: panel })),
        channelAdmission: vi.fn(async () => ({ allowed: false, reason: "cap_reached", spent_30d: 900 })),
        runDispatch: vi.fn(async () => result({ parsed: { steps: [{ title: "x" }] } })),
      });
      const r = await runVariants({ tenantId: T1, agentSlug: "seo", input: past, variantSlugs: ["default"], deps });
      expect(r.admission).toEqual({ allowed: false, reason: "cap_reached", spent_30d: 900 });
      expect(r.results[0].ok).toBe(true);
    });

    it("a blocked write shows as a would-propose card; a blocked hand-off does not", async () => {
      const input = '{"campaign_id":"123","daily_budget_usd":80}';
      const { deps } = makeDeps({
        loadRecipe,
        channelCards: vi.fn(async () => ({ ok: true as const, value: panel })),
        runDispatch: vi.fn(async () =>
          result({
            parsed: { steps: [{ title: "x" }] },
            tool_calls: [
              { name: "meta_ads__update_adset_budget", input_preview: input, output_preview: "blocked in variants lab", ms: 0, status: "tool_error", code: LAB_DENY_CODE },
              { name: "praxis__handoff", input_preview: "{}", output_preview: "", ms: 0, status: "tool_error", code: LAB_DENY_CODE },
              { name: "github__read_file", input_preview: "{}", output_preview: "{}", ms: 1, status: "ok" },
            ],
          }),
        ),
      });
      const r = await runVariants({ tenantId: T1, agentSlug: "seo", input: past, variantSlugs: ["default"], deps });
      expect(r.results[0].proposals).toEqual([{ tool: "meta_ads__update_adset_budget", input }]);
    });
  });

  it("a channel replay loads the recipe of the run's own channel, not the executor's", async () => {
    const loadRecipe = vi.fn(() => ({ body: "r", meta: { router: [], inputs: [], artifact: "a", min_evidence: 1 } })) as unknown as RunVariantsDeps["loadRecipe"];
    const { deps } = makeDeps({ loadRecipe });
    const src = runRows[runRows.length - 1].payload as Record<string, unknown>;
    src.channel_slug = "geo";
    try {
      await runVariants({ tenantId: T1, agentSlug: "seo", input: { kind: "past_run", runId: "c4a00000" }, variantSlugs: ["default"], deps });
    } finally {
      src.channel_slug = "seo";
    }
    expect((loadRecipe as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe("geo");
  });

  it("replays a chat run that stores only the message id, reading the founder's message", async () => {
    const { deps } = makeDeps();
    const r = await runVariants({ tenantId: T1, agentSlug: "cgo", input: { kind: "past_run", runId: "ca000001" }, variantSlugs: ["default"], deps });
    const t = (r.input as { text: string }).text;
    expect(t).toContain("Founder: What is our budget?");
    expect(t).toContain("You: It is $25,000 for October.");
    expect(t).toMatch(/The founder now says:\nWhy did signups drop last week\?$/);
    expect(t).not.toContain("LEAK");
    expect(t).not.toContain("SYSTEM internal");
    expect(t).not.toContain("OLD budget");
    const claim = (deps.buildContext as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(claim.trigger).toBe("slack");
  });

  it("never reads another tenant's message for a chat replay", async () => {
    const { deps } = makeDeps();
    await expect(
      runVariants({ tenantId: T1, agentSlug: "cgo", input: { kind: "past_run", runId: "ca000002" }, variantSlugs: ["default"], deps }),
    ).rejects.toThrow(/no question text/);
  });

  it("refuses a chat message with attachments instead of replaying it without them", async () => {
    const { deps } = makeDeps();
    await expect(
      runVariants({ tenantId: T1, agentSlug: "cgo", input: { kind: "past_run", runId: "ca000003" }, variantSlugs: ["default"], deps }),
    ).rejects.toThrow(/attachments/);
  });

  it("refuses a chat run whose media rides on the payload (video-only message)", async () => {
    const { deps } = makeDeps();
    await expect(
      runVariants({ tenantId: T1, agentSlug: "cgo", input: { kind: "past_run", runId: "ca000004" }, variantSlugs: ["default"], deps }),
    ).rejects.toThrow(/attachments/);
  });
});

