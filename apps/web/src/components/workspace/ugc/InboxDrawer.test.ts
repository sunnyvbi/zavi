
import { describe, expect, it } from "vitest";
import type { CreatorJobSummary } from "@/components/humans/creatorJobTypes";
import { buildInbox } from "./InboxDrawer";
import type { BusinessThreadSummary } from "./types";

const TARUN = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const MAYA = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const HUB = "/workspace?tab=channels&channel=ugc";

const job = (over: Partial<CreatorJobSummary>): CreatorJobSummary =>
  ({
    id: "j1",
    source: "booking",
    status: "in_progress",
    closed_reason: null,
    title: "1 UGC video",
    creator_display_name: "Tarun Asnani",
    creator_slug: "tarun",
    human_member_id: TARUN,
    created_at: "2026-09-28T00:00:00Z",
    due_at: null,
    money: {} as CreatorJobSummary["money"],
    deadline: null,
    awaiting_creator: false,
    ...over,
  }) as CreatorJobSummary;

const thread = (over: Partial<BusinessThreadSummary>): BusinessThreadSummary => ({
  thread_id: "t1",
  human_member_id: MAYA,
  display_name: "Maya",
  last_message: { body: "Hi", sender_kind: "creator", created_at: "2026-09-29T10:00:00Z" },
  last_message_at: "2026-09-29T10:00:00Z",
  ...over,
});

describe("buildInbox", () => {
  it("puts a creator's thread and jobs on one entry", () => {
    const [e] = buildInbox([thread({ human_member_id: TARUN, display_name: "Tarun Asnani" })], [job({})], []);
    expect(e.human_member_id).toBe(TARUN);
    expect(e.thread?.thread_id).toBe("t1");
    expect(e.jobs.map((j) => j.job.id)).toEqual(["j1"]);
  });

  it("lists a delivered job first, with Review as its drawer", () => {
    const list = buildInbox([thread({})], [job({ status: "submitted" })], []);
    expect(list[0].human_member_id).toBe(TARUN);
    expect(list[0].needsYou).toBe(true);
    expect(list[0].jobs[0].row.drawer).toBe("review");
  });

  it("attributes unread notifications by creator link and by job link", () => {
    const list = buildInbox(
      [thread({})],
      [job({})],
      [
        { id: "n1", link_path: `${HUB}&drawer=thread&creator=${MAYA}`, read_at: null },
        { id: "n2", link_path: `${HUB}&drawer=job&job=j1`, read_at: null },
        { id: "n3", link_path: `${HUB}&drawer=job&job=j1`, read_at: "2026-09-29T00:00:00Z" },
      ],
    );
    const by = Object.fromEntries(list.map((e) => [e.human_member_id, e.unread]));
    expect(by[MAYA]).toEqual(["n1"]);
    expect(by[TARUN]).toEqual(["n2"]);
  });

  it("skips jobs that were never paid", () => {
    expect(buildInbox([], [job({ status: "checkout_pending" })], [])).toEqual([]);
  });
});
