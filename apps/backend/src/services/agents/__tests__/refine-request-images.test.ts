import { describe, it, expect, vi, type Mock } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  refineProduct,
  type RefineProductDeps,
  type RefineProductInput,
  type PriorRefineTurn,
} from "@/services/agents/refine-product";
import {
  parseRefineImagePaths,
  resolveRefineRequestImages,
  MAX_REFINE_IMAGE_BYTES,
} from "@/services/agents/refine-request-images";
import { buildSdkUserPrompt } from "@/services/agents/generic-dispatcher";
import type { ConductorNode } from "@/services/agents/conductor";
import type { SiteRow } from "@/services/sites/contract";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT = "99999999-9999-4999-8999-999999999999";
const SESSION = "d130919a-bec1-48bc-9dbf-fba65217f05a";
const SITE_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const SHOT = `${TENANT}/22222222-2222-4222-8222-222222222222.jpg`;
const SHOT_2 = `${TENANT}/33333333-3333-4333-8333-333333333333.jpg`;
const FOREIGN = `${OTHER_TENANT}/44444444-4444-4444-8444-444444444444.jpg`;
const SHOT_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8, 0xff, 0xd9]);

const SITE: SiteRow = {
  id: SITE_ID,
  tenant_id: TENANT,
  root_conductor_run_id: SESSION,
  started_by_user_id: null,
  owner_email: "owner@example.test",
  label: "alpha",
  hostname: "alpha.zaviagent.com",
  github_full_name: "praxis-built/alpha",
  supabase_project_ref: "ref",
  supabase_url: "https://ref.supabase.co",
  status: "live",
  live_url: "https://alpha.zaviagent.com",
  desired_sha: "1111111",
  live_sha: "1111111",
  live_deploy_id: "d00000000a-live0001",
  last_visit_at: null,
  last_edit_at: null,
  paused_at: null,
  last_error: null,
  created_at: "2026-09-30T00:00:00Z",
  updated_at: "2026-09-30T00:00:00Z",
};

type MockDeps = RefineProductDeps & { [K in keyof RefineProductDeps]: Mock };

function deps(): MockDeps {
  return {
    loadProvisionedTarget: vi.fn().mockResolvedValue(null),
    loadPriorRefines: vi.fn().mockResolvedValue([] as PriorRefineTurn[]),
    verifyConductorRunOwnership: vi.fn().mockResolvedValue(true),
    loadConductorRunKind: vi.fn().mockResolvedValue("build_app"),
    tryAcquireBuildSlot: vi.fn().mockResolvedValue("cr_refine_1"),
    updateConductorRunStatus: vi.fn().mockResolvedValue(undefined),
    resolveDailyCap: vi.fn().mockResolvedValue(0),
    loadRepoHeadSha: vi.fn().mockResolvedValue("1111111"),
    resolveRefineDirectMergeEnabled: vi.fn().mockResolvedValue(true),
    isFleetHalted: vi.fn().mockResolvedValue(false),
    loadAppPolicy: vi.fn().mockResolvedValue({ protected_globs: [], freeze: false, preview: "branch_preview" }),
    loadSiteForRun: vi.fn().mockResolvedValue({ ...SITE }),
    markSiteEdited: vi.fn().mockResolvedValue(undefined),
    resolveSiteFastEditNode: vi.fn().mockResolvedValue(true),
    resolveSiteEditTimingLog: vi.fn().mockResolvedValue(true),
    resolveSiteEditAutoRoute: vi.fn().mockResolvedValue(true),
  } as unknown as MockDeps;
}

function graphOf(d: MockDeps): ConductorNode[] {
  for (const call of d.updateConductorRunStatus.mock.calls) {
    const arg = call[0] as { goal_graph?: ConductorNode[] };
    if (arg.goal_graph) return arg.goal_graph;
  }
  throw new Error("no goal_graph written");
}

function storage(objects: Record<string, Buffer>) {
  const downloads: Array<{ bucket: string; path: string }> = [];
  const sb = {
    storage: {
      from: (bucket: string) => ({
        download: async (path: string) => {
          downloads.push({ bucket, path });
          const bytes = bucket === "agent-chat-images" ? objects[path] : undefined;
          return bytes ? { data: new Blob([bytes]), error: null } : { data: null, error: { message: "not found" } };
        },
      }),
    },
  } as unknown as SupabaseClient;
  return { sb, downloads };
}

const change = (message: string, over: Partial<RefineProductInput> = {}): RefineProductInput => ({
  tenant_id: TENANT,
  message,
  conductor_run_id: SESSION,
  ...over,
});

type Block = { type: string; text?: string; source?: { type: string; media_type?: string; data?: string } };

async function agentTurnFor(payload: unknown, sb: SupabaseClient, intent = "the refine task") {
  const content = await resolveRefineRequestImages(sb, TENANT, payload, intent);
  return buildSdkUserPrompt({
    messages: [{ role: "user", content: intent }],
    current_message_content: content ?? undefined,
    resumeSessionId: null,
    runId: "run-1",
    threadId: null,
  }) as string | Block[];
}

describe("a screenshot attached to a build change reaches the engineer as an image", () => {
  it("the founder's screenshot is on the engineer node and is the first block of the engineer's turn", async () => {
    const d = deps();
    await refineProduct(change("fix this", { image_paths: [SHOT] }), d);
    const [engineer] = graphOf(d);
    expect(engineer.payload).toMatchObject({ refine_mode: true, request_image_paths: [SHOT], idea: "fix this" });
    expect(engineer.payload).not.toHaveProperty("fast_edit");
    expect(engineer.payload).not.toHaveProperty("chat_photo_paths");

    const { sb, downloads } = storage({ [SHOT]: SHOT_BYTES });
    const turn = await agentTurnFor(engineer.payload, sb);
    expect(Array.isArray(turn)).toBe(true);
    const blocks = turn as Block[];
    expect(blocks[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: SHOT_BYTES.toString("base64") },
    });
    expect(blocks[blocks.length - 1]).toEqual({ type: "text", text: "the refine task" });
    expect(downloads).toEqual([{ bucket: "agent-chat-images", path: SHOT }]);
  });

  it("a tweak that would take the fast pass keeps the full pass when it carries a screenshot", async () => {
    const plain = deps();
    await refineProduct(change("make the call button green"), plain);
    expect(graphOf(plain)[0].payload).toMatchObject({ fast_edit: true });

    const shot = deps();
    await refineProduct(change("make the call button green", { image_paths: [SHOT], small_edit: true }), shot);
    expect(graphOf(shot)[0].payload).not.toHaveProperty("fast_edit");
    expect(graphOf(shot)[0].payload).not.toHaveProperty("small_edit");
  });

  it("another tenant's image path never lands on the node and is never downloaded", async () => {
    const d = deps();
    await refineProduct(change("make it look like this", { image_paths: [FOREIGN, SHOT_2] }), d);
    const [engineer] = graphOf(d);
    expect(engineer.payload).toMatchObject({ request_image_paths: [SHOT_2] });

    const forged = { ...engineer.payload, request_image_paths: [FOREIGN] };
    const { sb, downloads } = storage({ [FOREIGN]: SHOT_BYTES });
    const turn = await agentTurnFor(forged, sb);
    expect(turn).toBe("the refine task");
    expect(downloads).toEqual([]);
  });

  it("an object over the upload cap is not sent to the model and the engineer is told it could not load", async () => {
    const big = Buffer.alloc(MAX_REFINE_IMAGE_BYTES + 1, 7);
    const { sb } = storage({ [SHOT]: big, [SHOT_2]: SHOT_BYTES });
    const blocks = (await agentTurnFor({ refine_mode: true, request_image_paths: [SHOT, SHOT_2] }, sb)) as Block[];
    const images = blocks.filter((b) => b.type === "image");
    expect(images).toHaveLength(1);
    expect(images[0].source?.data).toBe(SHOT_BYTES.toString("base64"));
    expect(blocks.some((b) => b.type === "text" && /could not be loaded/.test(b.text ?? ""))).toBe(true);
  });

  it("only a refine run shows request images", async () => {
    const { sb, downloads } = storage({ [SHOT]: SHOT_BYTES });
    expect(await agentTurnFor({ request_image_paths: [SHOT] }, sb)).toBe("the refine task");
    expect(downloads).toEqual([]);
  });
});

describe("parseRefineImagePaths", () => {
  it("accepts this tenant's uploaded images", () => {
    expect(parseRefineImagePaths(TENANT, [SHOT, SHOT_2])).toEqual({ ok: true, paths: [SHOT, SHOT_2] });
    expect(parseRefineImagePaths(TENANT, undefined)).toEqual({ ok: true, paths: [] });
  });

  it.each([
    ["another tenant's image", [FOREIGN]],
    ["one foreign image among own", [SHOT, FOREIGN]],
    ["a document", [`${TENANT}/55555555-5555-4555-8555-555555555555.pdf`]],
    ["a nested path", [`${TENANT}/x/22222222-2222-4222-8222-222222222222.jpg`]],
    ["a non-string", [SHOT, 42]],
    ["four images", [SHOT, SHOT_2, `${TENANT}/66666666-6666-4666-8666-666666666666.jpg`, `${TENANT}/77777777-7777-4777-8777-777777777777.jpg`]],
    ["not a list", SHOT],
  ])("refuses %s", (_label, raw) => {
    expect(parseRefineImagePaths(TENANT, raw).ok).toBe(false);
  });
});
