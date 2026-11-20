import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { CHANNELS } from "@zavi/shared";
import { joinChannelStates } from "@/services/channels/state";
import { assembleChannels, foldLatestRuns, type LatestRun } from "../list";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-09-05T07:10:00.000Z");
const STALE = 2 * HOUR;

const base = {
  linked: new Set<string>(),
  latestRun: new Map<string, LatestRun>(),
  runsAvailable: true,
  now: NOW,
  staleMs: STALE,
};

const run = (status: string, msAgo: number, id = "run-1"): LatestRun => {
  const iso = new Date(NOW - msAgo).toISOString();
  return { id, status, started_at: iso, at: iso };
};

const statesFrom = (...rows: Array<Record<string, unknown> & { channel_slug: string }>) =>
  joinChannelStates(rows);

describe("assembleChannels — the registry leads, the rows are only state", () => {
  it("every registry channel is present even when this tenant seeded only one", () => {
    const out = assembleChannels({ ...base, states: statesFrom({ channel_slug: "seo" }) });
    expect(out).toHaveLength(CHANNELS.length);
    expect(out.map((c) => c.channel_slug).sort()).toEqual(
      CHANNELS.map((c) => c.slug).sort(),
    );
  });

  it("assumes the caller already refused a zero-row read (authorization, not display)", () => {
    const src = readFileSync(join(__dirname, "..", "list.ts"), "utf8");
    expect(src).toMatch(/if \(rowCount === 0\)/);
    expect(src).toMatch(/res\.json\(\{ channels: \[\], channel_locks, channel_locks_known \}\)/);
  });

  it("an unseeded channel with a live run reports running, not idle", () => {
    const out = assembleChannels({
      ...base,
      states: statesFrom({ channel_slug: "seo" }),
      latestRun: new Map([["ugc", run("running", 3 * 60_000)]]),
    });
    const ugc = out.find((c) => c.channel_slug === "ugc");
    expect(ugc).toBeDefined();
    expect(ugc!.work_state).toBe("running");
  });

  it("an unseeded channel that finished reports delivered, so last-worked stops saying Never", () => {
    const out = assembleChannels({
      ...base,
      states: statesFrom({ channel_slug: "seo" }),
      latestRun: new Map([["ugc", run("success", 10 * 60_000)]]),
    });
    const ugc = out.find((c) => c.channel_slug === "ugc")!;
    expect(ugc.work_state).toBe("delivered");
    expect(ugc.last_run_at).toBe(new Date(NOW - 10 * 60_000).toISOString());
  });

  it("a run's timestamp beats a stale cached one, and the cache is the fallback", () => {
    const cached = "2026-09-01T00:00:00.000Z";
    const out = assembleChannels({
      ...base,
      states: statesFrom({ channel_slug: "seo", last_run_at: cached }),
      latestRun: new Map([["seo", run("success", 60_000)]]),
    });
    expect(out.find((c) => c.channel_slug === "seo")!.last_run_at).toBe(
      new Date(NOW - 60_000).toISOString(),
    );
    const degraded = assembleChannels({
      ...base,
      states: statesFrom({ channel_slug: "seo", last_run_at: cached }),
      runsAvailable: false,
    });
    expect(degraded.find((c) => c.channel_slug === "seo")!.last_run_at).toBe(cached);
  });

  it("a run with no started_at still reports, using its enqueue time", () => {
    const enq = new Date(NOW - 45_000).toISOString();
    const out = assembleChannels({
      ...base,
      states: statesFrom({ channel_slug: "seo" }),
      latestRun: new Map([["ugc", { id: "run-q", status: "queued", started_at: null, at: enq }]]),
    });
    const ugc = out.find((c) => c.channel_slug === "ugc")!;
    expect(ugc.work_state).toBe("running");
    expect(ugc.last_run_at).toBe(enq);
  });

  it("a row for a slug the registry no longer carries is dropped", () => {
    const out = assembleChannels({
      ...base,
      states: statesFrom({ channel_slug: "winback", work_state: "delivered" }),
    });
    expect(out.some((c) => c.channel_slug === "winback")).toBe(false);
  });

  it("seeded state still wins where it is the only source — priority and last_run_at", () => {
    const seeded = "2026-09-04T18:57:28.325Z";
    const out = assembleChannels({
      ...base,
      states: statesFrom({ channel_slug: "seo", priority: 1, last_run_at: seeded }),
    });
    const seo = out.find((c) => c.channel_slug === "seo")!;
    expect(seo.priority).toBe(1);
    expect(seo.last_run_at).toBe(seeded);
    const ugc = out.find((c) => c.channel_slug === "ugc")!;
    expect(ugc.priority).toBe(100);
    expect(ugc.last_run_at).toBeNull();
  });

  it("ordering is unchanged: priority ascending, ties broken by slug", () => {
    const out = assembleChannels({
      ...base,
      states: statesFrom({ channel_slug: "seo", priority: 3 }, { channel_slug: "meta_ads", priority: 1 }),
    });
    expect(out[0].channel_slug).toBe("meta_ads");
    expect(out[1].channel_slug).toBe("seo");
    const rest = out.slice(2).map((c) => c.channel_slug);
    expect(rest).toEqual([...rest].sort());
  });

  it("when the agent_runs read failed, an unseeded channel falls back to idle rather than throwing", () => {
    const out = assembleChannels({ ...base, states: statesFrom({ channel_slug: "seo" }), runsAvailable: false });
    expect(out.every((c) => c.work_state === "idle")).toBe(true);
  });

  it("carries the change-probe fields through, and reports null where never probed", () => {
    const probed = "2026-09-05T06:00:00.000Z";
    const out = assembleChannels({
      ...base,
      states: statesFrom({ channel_slug: "seo", last_probe_at: probed }),
    });
    expect(out.find((c) => c.channel_slug === "seo")!.last_probe_at).toBe(probed);
    expect(out.find((c) => c.channel_slug === "ugc")!.last_probe_at).toBeNull();
  });

  it("carries recipe presence so the CTA can say 'Coming soon' instead of failing", () => {
    const out = assembleChannels({ ...base, states: statesFrom({ channel_slug: "seo" }) });
    expect(out.every((c) => typeof c.runnable === "boolean")).toBe(true);
    expect(out.find((c) => c.channel_slug === "ugc")!.runnable).toBe(true);
  });
});

describe("foldLatestRuns: a founder paste's record run is not the channel's latest run", () => {
  const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
  const paste = {
    id: "paste-run",
    channel_slug: "email_marketing",
    status: "success",
    enqueued_at: iso(60_000),
    started_at: iso(60_000),
    finished_at: iso(60_000),
    agent_definition_hash: "email_marketing_founder_paste",
  };

  it("a paste newer than a running agent run leaves the tile running, with the agent run's id and time", () => {
    const running = { id: "agent-run", channel_slug: "email_marketing", status: "running", enqueued_at: iso(5 * 60_000), started_at: iso(5 * 60_000), finished_at: null, agent_definition_hash: "h1" };
    const latest = foldLatestRuns([paste, running]);
    expect(latest.get("email_marketing")).toEqual({ id: "agent-run", status: "running", started_at: iso(5 * 60_000), at: iso(5 * 60_000) });
    const out = assembleChannels({ ...base, states: statesFrom({ channel_slug: "email_marketing" }), latestRun: latest });
    const email = out.find((c) => c.channel_slug === "email_marketing")!;
    expect(email.work_state).toBe("running");
    expect(email.last_run_at).toBe(iso(5 * 60_000));
  });

  it("a paste newer than a failed agent run leaves the failure showing", () => {
    const failed = { id: "agent-run", channel_slug: "email_marketing", status: "failed", enqueued_at: iso(30 * 60_000), started_at: null, finished_at: iso(29 * 60_000), agent_definition_hash: null };
    const out = assembleChannels({ ...base, states: statesFrom({ channel_slug: "email_marketing" }), latestRun: foldLatestRuns([paste, failed]) });
    expect(out.find((c) => c.channel_slug === "email_marketing")!.work_state).toBe("needs_review");
  });

  it("a channel whose only run is a paste reports no run, and other channels' runs are untouched", () => {
    const seo = { id: "seo-run", channel_slug: "seo", status: "success", enqueued_at: iso(90_000), started_at: iso(90_000), finished_at: iso(80_000) };
    const latest = foldLatestRuns([paste, seo]);
    expect(latest.has("email_marketing")).toBe(false);
    expect(latest.get("seo")).toMatchObject({ id: "seo-run", at: iso(80_000) });
  });
});

describe("foldLatestRuns: a chat-requested video holder run is not the channel's latest run", () => {
  const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
  const holder = (status: string) => ({
    id: "holder-run",
    channel_slug: "generated_video",
    status,
    enqueued_at: iso(60_000),
    started_at: iso(60_000),
    finished_at: iso(60_000),
    agent_definition_hash: "generated-video-requested-card",
  });
  const suggest = { id: "suggest-run", channel_slug: "generated_video", status: "running", enqueued_at: iso(5 * 60_000), started_at: iso(5 * 60_000), finished_at: null, agent_definition_hash: "h1" };

  it("a successful holder newer than a running Suggest run leaves the tile running", () => {
    const latest = foldLatestRuns([holder("success"), suggest]);
    expect(latest.get("generated_video")).toEqual({ id: "suggest-run", status: "running", started_at: iso(5 * 60_000), at: iso(5 * 60_000) });
    const out = assembleChannels({ ...base, states: statesFrom({ channel_slug: "generated_video" }), latestRun: latest });
    const tile = out.find((c) => c.channel_slug === "generated_video")!;
    expect(tile.work_state).toBe("running");
    expect(tile.last_run_at).toBe(iso(5 * 60_000));
  });

  it("a failed holder does not show the channel as a run that did not finish", () => {
    const done = { ...suggest, status: "success", finished_at: iso(4 * 60_000) };
    const latest = foldLatestRuns([holder("failed"), done]);
    expect(latest.get("generated_video")).toMatchObject({ id: "suggest-run", status: "success" });
    const out = assembleChannels({ ...base, states: statesFrom({ channel_slug: "generated_video" }), latestRun: latest });
    expect(out.find((c) => c.channel_slug === "generated_video")!.work_state).not.toBe("needs_review");
  });

  it("a channel whose only runs are holders reports no run", () => {
    expect(foldLatestRuns([holder("success"), holder("failed")]).has("generated_video")).toBe(false);
  });
});
