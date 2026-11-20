import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const { rpcMock, insertMock, threadRow, runRow, updateMock, eqSpy } = vi.hoisted(() => ({
  rpcMock: vi.fn(),
  insertMock: vi.fn(),
  updateMock: vi.fn(),
  eqSpy: vi.fn(),
  threadRow: { value: { data: { id: "thr-1" }, error: null } as unknown },
  runRow: { value: { data: null, error: null } as unknown, throws: false },
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    rpc: rpcMock,
    from: (table: string) => ({
      select: () => {
        const chain = {
          eq: (col: string, val: unknown) => {
            eqSpy(table, col, val);
            return chain;
          },
          maybeSingle: async () => {
            if (table !== "conductor_runs") return threadRow.value;
            if (runRow.throws) throw new Error("db down");
            return runRow.value;
          },
        };
        return chain;
      },
      insert: (row: unknown) => {
        insertMock(table, row);
        return Promise.resolve({ error: null });
      },
      update: (row: unknown) => {
        updateMock(table, row);
        return { eq: async () => ({ error: null }) };
      },
    }),
  }),
}));

import { postRefineGoingLive, siteEditStopsAtPreview } from "../post-run";
import { refineProduct, type RefineProductDeps } from "@/services/agents/refine-product";
import { BUILD_CONDUCTOR_RUN_ID_KEY } from "@/services/billing/tiers";
import { siteRow } from "@/services/sites/__tests__/fake-site-store";
import type { ConductorNode } from "@/services/agents/conductor";

const ARGS = { tenant_id: "ten-1", run_id: "run-1", thread_id: "thr-1" };

beforeEach(() => {
  rpcMock.mockReset();
  insertMock.mockReset();
  updateMock.mockReset();
  eqSpy.mockReset();
  threadRow.value = { data: { id: "thr-1" }, error: null };
  runRow.value = { data: null, error: null };
  runRow.throws = false;
});

describe("postRefineGoingLive", () => {
  it("does NOT go through record_handoff_chat_message (its preconditions cannot be met here)", async () => {
    await postRefineGoingLive(ARGS);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("verifies the thread belongs to THIS tenant before writing anything", async () => {
    await postRefineGoingLive(ARGS);
    expect(eqSpy).toHaveBeenCalledWith("agent_threads", "id", "thr-1");
    expect(eqSpy).toHaveBeenCalledWith("agent_threads", "tenant_id", "ten-1");
  });

  it("inserts the reply into the customer's thread, tenant-stamped", async () => {
    await postRefineGoingLive(ARGS);
    expect(insertMock).toHaveBeenCalledTimes(1);
    const [table, row] = insertMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(table).toBe("agent_thread_messages");
    expect(row.thread_id).toBe("thr-1");
    expect(row.tenant_id).toBe("ten-1");
    expect(row.agent_run_id).toBe("run-1");
    expect(row.sender_role).toBe("assistant");
    expect(String(row.body).length).toBeGreaterThan(0);
  });

  it("writes NOTHING when the thread does not belong to the tenant", async () => {
    threadRow.value = { data: null, error: null };
    await postRefineGoingLive(ARGS);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("never throws — a failed post must not fail the engineer run", async () => {
    threadRow.value = { data: null, error: { message: "boom" } };
    await expect(postRefineGoingLive(ARGS)).resolves.toBeUndefined();
  });
});

describe("the going-live post runs after pre-dispatch validation, not at stamp time", () => {
  const src = readFileSync(join(__dirname, "../post-run.ts"), "utf-8");

  it("the stamp block only REMEMBERS the thread; it does not post", () => {
    const stampStart = src.indexOf("Autopilot codegen→push-to-main stamp");
    const stampBlock = src.slice(stampStart, stampStart + 16000);
    expect(stampBlock).toMatch(/refineGoingLiveThreadId\s*=\s*pl\.chat_thread_id/);
    expect(stampBlock).not.toContain("postRefineGoingLive(");
    expect(stampBlock).not.toContain("record_handoff_chat_message");
  });

  it("the call site sits after the FINAL pre-dispatch validation", () => {
    const validateAt = src.indexOf("FINAL pre-dispatch validation");
    const callAt = src.indexOf("await postRefineGoingLive(");
    expect(validateAt).toBeGreaterThan(-1);
    expect(callAt).toBeGreaterThan(validateAt);
  });

  it("post-run no longer references the handoff-only RPC for this path", () => {
    expect(src).not.toContain("record_handoff_chat_message({");
    expect(src).not.toMatch(/rpc\(\s*"record_handoff_chat_message"/);
  });
});

describe("postRefineGoingLive — the copy claims what we did, not what happened", () => {
  it("does not assert the change is already live/done deploying", async () => {
    await postRefineGoingLive(ARGS);
    const [, row] = insertMock.mock.calls[0] as [string, Record<string, unknown>];
    const body = String(row.body).toLowerCase();
    expect(body).not.toMatch(/it'?s (now )?live\b/);
    expect(body).not.toMatch(/\bdeployed\b/);
  });
});

describe("an edit that stops at the preview (build_publish_on_request, site never published)", () => {
  const SITE_ID = "aaaaaaaa-0000-4000-8000-000000000001";
  const ROOT = "d130919a-bec1-48bc-9dbf-fba65217f05a";
  const EDIT_RUN = "0f8fad5b-d9cb-469f-a165-70867728950e";
  const TENANT = "11111111-1111-4111-8111-111111111111";

  async function editGraph(live_deploy_id: string | null, publishOnRequest: boolean, directMerge = true): Promise<ConductorNode[]> {
    const update = vi.fn().mockResolvedValue(undefined);
    const deps = {
      loadProvisionedTarget: vi.fn().mockResolvedValue(null),
      loadPriorRefines: vi.fn().mockResolvedValue([]),
      verifyConductorRunOwnership: vi.fn().mockResolvedValue(true),
      loadConductorRunKind: vi.fn().mockResolvedValue("build_app"),
      tryAcquireBuildSlot: vi.fn().mockResolvedValue(EDIT_RUN),
      updateConductorRunStatus: update,
      resolveDailyCap: vi.fn().mockResolvedValue(0),
      loadRepoHeadSha: vi.fn().mockResolvedValue("1111111"),
      resolveRefineDirectMergeEnabled: vi.fn().mockResolvedValue(directMerge),
      isFleetHalted: vi.fn().mockResolvedValue(false),
      loadAppPolicy: vi.fn().mockResolvedValue({ protected_globs: [], freeze: false, preview: "branch_preview" }),
      loadSiteForRun: vi.fn().mockResolvedValue(
        siteRow({ id: SITE_ID, tenant_id: TENANT, label: "alpha", root_conductor_run_id: ROOT, status: live_deploy_id ? "live" : "building", live_deploy_id }),
      ),
      markSiteEdited: vi.fn().mockResolvedValue(undefined),
      resolveBuildPublishOnRequest: vi.fn().mockResolvedValue(publishOnRequest),
    } as unknown as RefineProductDeps;
    await refineProduct(
      { tenant_id: TENANT, message: "change the hero title to Rent e-bikes fast", conductor_run_id: ROOT, chat_thread_id: "thr-1" },
      deps,
    );
    const call = update.mock.calls.find((c) => (c[0] as { goal_graph?: unknown }).goal_graph);
    return (call![0] as { goal_graph: ConductorNode[] }).goal_graph;
  }

  const dispatched = (graph: ConductorNode[]) => ({ ...graph[0].payload, [BUILD_CONDUCTOR_RUN_ID_KEY]: EDIT_RUN });

  it("the real edit graph of a never-published site stops at preview, read tenant-scoped from the run's own row", async () => {
    const graph = await editGraph(null, true);
    runRow.value = { data: { goal_graph: graph }, error: null };
    expect(await siteEditStopsAtPreview(TENANT, dispatched(graph))).toBe(true);
    expect(eqSpy).toHaveBeenCalledWith("conductor_runs", "id", EDIT_RUN);
    expect(eqSpy).toHaveBeenCalledWith("conductor_runs", "tenant_id", TENANT);
  });

  it("a live site's edit stops at the preview too while the setting is on; with it off, live or not, the edit deploys", async () => {
    const live = await editGraph("d-live-1", true);
    expect(live.map((n) => n.payload.stage)).toEqual(["build"]);
    runRow.value = { data: { goal_graph: live }, error: null };
    expect(await siteEditStopsAtPreview(TENANT, dispatched(live))).toBe(true);
    for (const deployId of ["d-live-1", null]) {
      const graph = await editGraph(deployId, false);
      expect(graph.map((n) => n.payload.stage)).toEqual(["build", "deploy"]);
      runRow.value = { data: { goal_graph: graph }, error: null };
      expect(await siteEditStopsAtPreview(TENANT, dispatched(graph))).toBe(false);
    }
  });

  it("an edit parked under the brake is not a preview stop and keeps today's reply, whether or not the site was ever published", async () => {
    for (const deployId of [null, "d-live-1"]) {
      const graph = await editGraph(deployId, true, false);
      expect(graph.map((n) => n.payload.stage)).toEqual(["build"]);
      runRow.value = { data: { goal_graph: graph }, error: null };
      expect(await siteEditStopsAtPreview(TENANT, dispatched(graph))).toBe(false);
    }
  });

  it("an old-flow run is never a preview stop and is never read; a site run it cannot prove either way is unknown: no conductor id, an unreadable, missing, empty or throwing run row", async () => {
    const graph = await editGraph(null, true);
    const payload = dispatched(graph);
    runRow.value = { data: { goal_graph: graph }, error: null };
    eqSpy.mockClear();
    const oldFlow = { ...payload, site_id: undefined };
    expect(await siteEditStopsAtPreview(TENANT, oldFlow)).toBe(false);
    expect(await siteEditStopsAtPreview(TENANT, graph[0].payload)).toBe("unknown");
    expect(eqSpy).not.toHaveBeenCalled();
    runRow.value = { data: { goal_graph: graph }, error: { message: "boom" } };
    expect(await siteEditStopsAtPreview(TENANT, payload)).toBe("unknown");
    runRow.value = { data: null, error: null };
    expect(await siteEditStopsAtPreview(TENANT, payload)).toBe("unknown");
    runRow.value = { data: { goal_graph: [] }, error: null };
    expect(await siteEditStopsAtPreview(TENANT, payload)).toBe("unknown");
    runRow.value = { data: { goal_graph: graph }, error: null };
    runRow.throws = true;
    expect(await siteEditStopsAtPreview(TENANT, payload)).toBe("unknown");
  });

  it("the preview reply says the change is in the preview and that Publish puts it on the site's address, never that it is going live", async () => {
    await postRefineGoingLive({ ...ARGS, preview_only: true });
    expect(insertMock).toHaveBeenCalledTimes(1);
    const [table, row] = insertMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(table).toBe("agent_thread_messages");
    const body = String(row.body);
    expect(body).toMatch(/preview/i);
    expect(body).toMatch(/ready to review/i);
    expect(body).toMatch(/press Publish/);
    expect(body).not.toMatch(/live site|deploy|shipping|it'?s (now )?live\b/i);
    expect(row).toMatchObject({ thread_id: "thr-1", tenant_id: "ten-1", agent_run_id: "run-1", sender_role: "assistant" });
  });

  it("the usual reply is unchanged, with the flag false or absent", async () => {
    await postRefineGoingLive(ARGS);
    await postRefineGoingLive({ ...ARGS, preview_only: false });
    const bodies = insertMock.mock.calls.map((c) => String((c[1] as Record<string, unknown>).body));
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
    expect(bodies[0]).toContain("handed it off to deploy to your live site");
    expect(bodies[0]).not.toMatch(/preview/i);
  });

  it("the preview reply is tenant-guarded like the usual one: nothing is written on another tenant's thread", async () => {
    threadRow.value = { data: null, error: null };
    await postRefineGoingLive({ ...ARGS, preview_only: true });
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("post-run decides the wording from the run's own graph at the one call site", () => {
    const src = readFileSync(join(__dirname, "../post-run.ts"), "utf-8");
    const callAt = src.indexOf("await postRefineGoingLive(");
    const call = src.slice(callAt, src.indexOf("});", callAt));
    expect(call).toContain("preview_only: await siteEditStopsAtPreview(ctx.tenant_id, payload)");
    expect(src.split("await postRefineGoingLive(").length).toBe(2);
  });

  const LIVE_REPLY =
    "✅ Built and shipping — I've finished your change and handed it off to deploy " +
    "to your live site. It should show up in a minute or two; nothing for you to do " +
    "on your end.";
  const PREVIEW_REPLY =
    "✅ Built. Your change is ready to review in your preview; it should show up there " +
    "in a minute or two. Nothing changes at your site's address until you press Publish.";
  const UNKNOWN_REPLY =
    "✅ Built. I've finished your change and sent it to your preview. It should show " +
    "up there in a minute or two.";
  const SITE_ARGS = { tenant_id: TENANT, run_id: "run-1", thread_id: "thr-1" };

  async function replyFor(payload: unknown): Promise<string[]> {
    insertMock.mockClear();
    await postRefineGoingLive({ ...SITE_ARGS, preview_only: await siteEditStopsAtPreview(TENANT, payload) });
    return insertMock.mock.calls
      .filter((c) => c[0] === "agent_thread_messages")
      .map((c) => String((c[1] as Record<string, unknown>).body));
  }

  function expectNoLiveClaim(bodies: string[]) {
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toMatch(/live site|deploy|shipping|it'?s (now )?live\b/i);
    expect(bodies[0]).toMatch(/sent it to your preview/);
    expect(bodies[0]).not.toMatch(/publish/i);
    expect(bodies[0]).toBe(UNKNOWN_REPLY);
  }

  it("the graph read throws for a site edit that really stopped at the preview: the reply says it is in the preview and never claims the live site", async () => {
    const graph = await editGraph(null, true);
    expect(graph.map((n) => n.payload.stage)).toEqual(["build"]);
    runRow.value = { data: { goal_graph: graph }, error: null };
    runRow.throws = true;
    eqSpy.mockClear();
    expectNoLiveClaim(await replyFor(dispatched(graph)));
    expect(eqSpy).toHaveBeenCalledWith("conductor_runs", "id", EDIT_RUN);
    expect(eqSpy).toHaveBeenCalledWith("conductor_runs", "tenant_id", TENANT);
    expect(eqSpy).toHaveBeenCalledWith("agent_threads", "tenant_id", TENANT);
    const [, row] = insertMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(row).toMatchObject({ thread_id: "thr-1", tenant_id: TENANT, agent_run_id: "run-1", sender_role: "assistant" });
  });

  it("the read comes back as an error value, even carrying a graph with a deploy node: the reply makes no live claim and no unpublished claim", async () => {
    const live = await editGraph("d-live-1", false);
    const stopped = await editGraph(null, true);
    runRow.value = { data: { goal_graph: live }, error: { message: "timeout" } };
    expectNoLiveClaim(await replyFor(dispatched(stopped)));
    expectNoLiveClaim(await replyFor(dispatched(live)));
  });

  it.each([
    ["the run row is missing", { data: null, error: null }],
    ["the graph is empty", { data: { goal_graph: [] }, error: null }],
    ["the graph is null", { data: { goal_graph: null }, error: null }],
    ["the graph is not a list", { data: { goal_graph: { stage: "deploy" } }, error: null }],
    ["the row has no graph column", { data: {}, error: null }],
  ])("%s for a site edit: the reply says it is in the preview and never claims the live site", async (_name, row) => {
    const graph = await editGraph(null, true);
    runRow.value = row;
    expectNoLiveClaim(await replyFor(dispatched(graph)));
  });

  it("a site edit dispatched without its conductor run id cannot be read at all: the reply makes no live claim and no read is attempted", async () => {
    const graph = await editGraph(null, true);
    runRow.value = { data: { goal_graph: await editGraph("d-live-1", false) }, error: null };
    eqSpy.mockClear();
    expectNoLiveClaim(await replyFor(graph[0].payload));
    expect(eqSpy.mock.calls.filter((c) => c[0] === "conductor_runs")).toHaveLength(0);
  });

  it("a failed read does not stick: the next edit with a readable graph gets its exact known wording again", async () => {
    const stopped = await editGraph(null, true);
    const live = await editGraph("d-live-1", false);
    runRow.throws = true;
    expectNoLiveClaim(await replyFor(dispatched(stopped)));
    runRow.throws = false;
    runRow.value = { data: { goal_graph: stopped }, error: null };
    expect(await replyFor(dispatched(stopped))).toEqual([PREVIEW_REPLY]);
    runRow.value = { data: { goal_graph: live }, error: null };
    expect(await replyFor(dispatched(live))).toEqual([LIVE_REPLY]);
    runRow.value = { data: null, error: null };
    expectNoLiveClaim(await replyFor(dispatched(live)));
  });

  it("guard: a site edit whose graph has a deploy node keeps the usual wording exactly", async () => {
    for (const deployId of ["d-live-1", null]) {
      const graph = await editGraph(deployId, false);
      expect(graph.map((n) => n.payload.stage)).toEqual(["build", "deploy"]);
      runRow.value = { data: { goal_graph: graph }, error: null };
      expect(await replyFor(dispatched(graph))).toEqual([LIVE_REPLY]);
    }
  });

  it("guard: a site edit whose graph has no deploy node keeps the preview wording exactly", async () => {
    const graph = await editGraph(null, true);
    expect(graph.map((n) => n.payload.stage)).toEqual(["build"]);
    runRow.value = { data: { goal_graph: graph }, error: null };
    expect(await replyFor(dispatched(graph))).toEqual([PREVIEW_REPLY]);
  });

  it("guard: a non-site run keeps the usual wording when the read would throw, error, or return nothing, and its graph is never read", async () => {
    const graph = await editGraph(null, true);
    const oldFlow = { ...dispatched(graph), site_id: undefined };
    const blankSite = { ...dispatched(graph), site_id: "   " };
    eqSpy.mockClear();
    runRow.throws = true;
    expect(await replyFor(oldFlow)).toEqual([LIVE_REPLY]);
    expect(await replyFor(blankSite)).toEqual([LIVE_REPLY]);
    runRow.throws = false;
    runRow.value = { data: null, error: { message: "boom" } };
    expect(await replyFor(oldFlow)).toEqual([LIVE_REPLY]);
    runRow.value = { data: { goal_graph: [] }, error: null };
    expect(await replyFor(oldFlow)).toEqual([LIVE_REPLY]);
    runRow.value = { data: { goal_graph: graph }, error: null };
    expect(await replyFor(oldFlow)).toEqual([LIVE_REPLY]);
    expect(eqSpy.mock.calls.filter((c) => c[0] === "conductor_runs")).toHaveLength(0);
  });

  it("guard: the unknown-state reply is tenant-guarded like the others: nothing is written on another tenant's thread", async () => {
    const graph = await editGraph(null, true);
    runRow.throws = true;
    threadRow.value = { data: null, error: null };
    eqSpy.mockClear();
    expect(await replyFor(dispatched(graph))).toEqual([]);
    expect(insertMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
    expect(eqSpy).toHaveBeenCalledWith("agent_threads", "id", "thr-1");
    expect(eqSpy).toHaveBeenCalledWith("agent_threads", "tenant_id", TENANT);
  });
});
