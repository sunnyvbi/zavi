
import { describe, expect, it } from "vitest";
import {
  MAX_RUNS_CAP,
  parseRerunArgs,
  refusalReason,
  rerunsInFlight,
  selectRerunTargets,
  type PreviewRun,
  type SelectionInput,
} from "../rerun-dry-signup-previews";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function run(over: Partial<PreviewRun> = {}): PreviewRun {
  const tenant_id = over.tenant_id ?? A;
  const agent_slug = over.agent_slug ?? "reddit_organic";
  return {
    id: `run-${tenant_id.slice(0, 1)}-${agent_slug}`,
    tenant_id,
    agent_slug,
    status: "success",
    cron_dedupe_key: `first-run-preview:${tenant_id}:${agent_slug}`,
    preview_action_types: ["reply", "post"],
    ...over,
  };
}

function input(over: Partial<SelectionInput> = {}): SelectionInput {
  return {
    enrolled: new Set([A, B]),
    workspaces: [
      { id: A, slug: "acme", kind: "real", deleted_at: null },
      { id: B, slug: "bolt", kind: null, deleted_at: null },
    ],
    previewRuns: [run()],
    openCards: new Set(),
    usedChannels: new Set(),
    tenant: null,
    channel: null,
    ...over,
  };
}

describe("parseRerunArgs", () => {
  it("dry run by default", () => {
    expect(parseRerunArgs([])).toEqual({ apply: false, maxRuns: null, tenant: null, channel: null });
  });
  it("--apply needs --max-runs", () => {
    expect(parseRerunArgs(["--apply"])).toEqual({ error: expect.stringMatching(/--max-runs/) });
    expect(parseRerunArgs(["--apply", "--max-runs", "40"])).toMatchObject({ apply: true, maxRuns: 40 });
  });
  it("refuses more than 230 runs ($150), and nonsense counts", () => {
    expect(MAX_RUNS_CAP).toBe(230);
    expect(parseRerunArgs(["--apply", "--max-runs", "231"])).toEqual({ error: expect.stringMatching(/230/) });
    expect(parseRerunArgs(["--apply", "--max-runs", "230"])).toMatchObject({ maxRuns: 230 });
    for (const bad of ["0", "-1", "1.5", "ten", undefined]) {
      const argv = ["--apply", "--max-runs", ...(bad === undefined ? [] : [bad])];
      expect(parseRerunArgs(argv), String(bad)).toHaveProperty("error");
    }
  });
  it("scope filters must be a workspace id and a slug", () => {
    expect(parseRerunArgs(["--tenant", A, "--channel", "seo"])).toMatchObject({ tenant: A, channel: "seo" });
    expect(parseRerunArgs(["--tenant", "acme"])).toHaveProperty("error");
    expect(parseRerunArgs(["--channel", "Robert'); drop"])).toHaveProperty("error");
  });
});

describe("refusalReason", () => {
  it("refuses while signup_preview_real_cards is off: the re-runs would be dry again", () => {
    expect(refusalReason({ switchOn: false, inFlight: 0 })).toMatch(/OFF/);
  });
  it("refuses while an earlier re-run is still going", () => {
    expect(refusalReason({ switchOn: true, inFlight: 2 })).toMatch(/still queued or running/);
    expect(refusalReason({ switchOn: true, inFlight: 0 })).toBeNull();
  });
});

describe("rerunsInFlight", () => {
  it("is a running preview-key run whose dry row was retired (one this script started)", () => {
    const retired = run({ id: "dry", cron_dedupe_key: `first-run-preview-done:${A}:reddit_organic` });
    const live = run({ id: "rerun", status: "running", preview_action_types: null });
    const signupStillRunning = run({ agent_slug: "seo", status: "queued" });
    expect(rerunsInFlight([retired, live, signupStillRunning]).map((r) => r.id)).toEqual(["rerun"]);
  });
});

describe("selectRerunTargets", () => {
  it("takes a finished dry run that found something", () => {
    expect(selectRerunTargets(input()).targets).toEqual([{ tenant_id: A, slug: "acme", channel: "reddit_organic", run_id: "run-a-reddit_organic" }]);
  });

  it("leaves out a dry run that failed or found nothing, and a real (non-dry) run", () => {
    for (const r of [run({ status: "error" }), run({ preview_action_types: [] }), run({ preview_action_types: null })]) {
      expect(selectRerunTargets(input({ previewRuns: [r] })).targets).toEqual([]);
    }
  });

  it("leaves out test, deleted, dogfood and not-enrolled workspaces", () => {
    const cases: Array<Partial<SelectionInput>> = [
      { workspaces: [{ id: A, slug: "acme", kind: "test", deleted_at: null }] },
      { workspaces: [{ id: A, slug: "acme", kind: "real", deleted_at: "2026-10-01T00:00:00Z" }] },
      { workspaces: [{ id: A, slug: "upcar-ai", kind: "real", deleted_at: null }] },
      { enrolled: new Set([B]) },
    ];
    for (const c of cases) expect(selectRerunTargets(input(c)).targets).toEqual([]);
  });

  it("skips a channel with open cards or one the workspace ran itself, and says why", () => {
    const out = selectRerunTargets(
      input({
        previewRuns: [run(), run({ agent_slug: "seo" }), run({ agent_slug: "geo" })],
        openCards: new Set([`${A}:reddit_organic`]),
        usedChannels: new Set([`${A}:seo`]),
      }),
    );
    expect(out.targets.map((t) => t.channel)).toEqual(["geo"]);
    expect(out.skipped).toEqual([
      { tenant_id: A, channel: "reddit_organic", reason: "open_cards" },
      { tenant_id: A, channel: "seo", reason: "used" },
    ]);
  });

  it("ignores a retired (already re-run) row and honours --tenant / --channel", () => {
    const retired = run({ cron_dedupe_key: `first-run-preview-done:${A}:reddit_organic` });
    expect(selectRerunTargets(input({ previewRuns: [retired] })).targets).toEqual([]);
    const both = [run(), run({ tenant_id: B }), run({ agent_slug: "seo" })];
    expect(selectRerunTargets(input({ previewRuns: both, tenant: B })).targets.map((t) => t.tenant_id)).toEqual([B]);
    expect(selectRerunTargets(input({ previewRuns: both, channel: "seo" })).targets.map((t) => t.channel)).toEqual(["seo"]);
  });
});
