import { describe, it, expect, vi, beforeEach } from "vitest";

type Result = { data: unknown; error: { code?: string; message?: string } | null };
const h = vi.hoisted(() => ({
  calls: [] as Array<{ table: string; ops: Array<{ op: string; args: unknown[] }> }>,
  queues: {} as Record<string, Result[]>,
}));
vi.mock("@/services/tenant-client", () => {
  const client = {
    from(table: string) {
      const call = { table, ops: [] as Array<{ op: string; args: unknown[] }> };
      h.calls.push(call);
      const next = (): Result => {
        const q = h.queues[table];
        if (!q?.length) return { data: null, error: null };
        return q.length > 1 ? q.shift()! : q[0];
      };
      const b: Record<string, unknown> = {};
      for (const op of ["select", "eq", "in", "insert", "update", "upsert", "delete", "limit"]) {
        b[op] = (...args: unknown[]) => {
          call.ops.push({ op, args });
          return b;
        };
      }
      b.maybeSingle = () => Promise.resolve(next());
      b.single = () => Promise.resolve(next());
      b.then = (f: (v: unknown) => unknown, r?: (e: unknown) => unknown) => Promise.resolve(next()).then(f, r);
      return b;
    },
  };
  return { globalClient: () => client, selfAccountClient: () => client };
});
vi.mock("@/services/humans/store", () => ({ writeWithFreshSlug: vi.fn(), swapMemberHandles: vi.fn() }));

import { parseProfilePatch, setupStore } from "../creator-setup";

const ops = (table: string, op: string) =>
  h.calls.filter((c) => c.table === table).flatMap((c) => c.ops.filter((o) => o.op === op).map((o) => o.args));

beforeEach(() => {
  h.calls.length = 0;
  h.queues = {};
});

describe("setupStore", () => {
  it("syncEmail moves the notification address to the confirmed sign-in email", async () => {
    h.queues.human_member_pii = [{ data: { email: "old@example.com" }, error: null }, { data: null, error: null }];
    await expect(setupStore.syncEmail("m1", " new@example.com ")).resolves.toBe(true);
    expect(ops("human_member_pii", "update")[0][0]).toMatchObject({ email: "new@example.com" });
  });

  it("syncEmail writes nothing when the address already matches (any case) or there is no PII row", async () => {
    h.queues.human_member_pii = [{ data: { email: "Maya@Example.com" }, error: null }];
    await expect(setupStore.syncEmail("m1", "maya@example.com")).resolves.toBe(false);
    h.queues.human_member_pii = [{ data: null, error: null }];
    await expect(setupStore.syncEmail("m1", "maya@example.com")).resolves.toBe(false);
    expect(ops("human_member_pii", "update")).toHaveLength(0);
  });

  it("saveDob that matched no PII row and has no email is an error, not a saved step", async () => {
    h.queues.human_member_pii = [{ data: [], error: null }];
    await expect(setupStore.saveDob("m1", "1990-01-01")).rejects.toMatchObject({ code: "not_saved" });
  });

  it("saveDob with no PII row recreates it from the token email, with the date", async () => {
    h.queues.human_member_pii = [{ data: [], error: null }, { data: null, error: null }];
    await setupStore.saveDob("m1", "1990-01-01", " maya@example.com ");
    expect(ops("human_member_pii", "insert")[0][0]).toEqual({ human_member_id: "m1", email: "maya@example.com", date_of_birth: "1990-01-01" });
  });

  it("saveDob that updated the row succeeds", async () => {
    h.queues.human_member_pii = [{ data: [{ human_member_id: "m1" }], error: null }];
    await expect(setupStore.saveDob("m1", "1990-01-01")).resolves.toBeUndefined();
  });

  it("signup for an existing member repairs a missing PII row (email from the token)", async () => {
    h.queues.human_members = [{ data: { id: "m1" }, error: null }];
    const out = await setupStore.createAccount("u1", "Maya", " maya@example.com ");
    expect(out).toEqual({ id: "m1", created: false });
    expect(ops("human_member_pii", "upsert")[0][0]).toEqual({ human_member_id: "m1", email: "maya@example.com" });
    expect(ops("human_member_pii", "upsert")[0][1]).toMatchObject({ onConflict: "human_member_id", ignoreDuplicates: true });
  });

  it("addPackage removes the package again when the lane write fails", async () => {
    h.queues.creator_packages = [{ data: { id: "p1" }, error: null }];
    h.queues.human_members = [
      { data: { lanes: [] }, error: null },
      { data: null, error: { code: "XX000", message: "boom" } },
    ];
    await expect(
      setupStore.addPackage("m1", {
        kind: "ugc_video",
        title: "One video",
        price_cents: 10_000,
        delivery_days: 7,
        video_count: 1,
        video_length_seconds: 30,
        ad_rights_days: 30,
        addons: [],
      } as never),
    ).rejects.toBeTruthy();
    const del = h.calls.find((c) => c.table === "creator_packages" && c.ops.some((o) => o.op === "delete"))!;
    expect(del.ops.filter((o) => o.op === "eq").map((o) => o.args)).toEqual([
      ["id", "p1"],
      ["human_member_id", "m1"],
    ]);
  });

  it("a failed undo of the package is reported, not swallowed", async () => {
    h.queues.creator_packages = [{ data: { id: "p1" }, error: null }, { data: null, error: { code: "XX000", message: "undo failed" } }];
    h.queues.human_members = [{ data: null, error: { code: "XX000", message: "lane read failed" } }];
    await expect(
      setupStore.addPackage("m1", { kind: "ugc_video", title: "One video", price_cents: 10_000, delivery_days: 7, video_count: 1, video_length_seconds: 30, ad_rights_days: 30, addons: [] } as never),
    ).rejects.toBeTruthy();
    expect(h.calls.some((c) => c.table === "creator_packages" && c.ops.some((o) => o.op === "delete"))).toBe(true);
  });
});

describe("parseProfilePatch intro video", () => {
  const USER = "11111111-1111-4111-8111-111111111111";

  it.each(["jpg", "png", "webp", "gif", "txt", "MP4", "mp4.jpg"])(
    "refuses an own upload ending in .%s, since the intro route serves it as video",
    (ext) => {
      expect(() => parseProfilePatch({ intro_video_path: `${USER}/clip.${ext}` }, USER)).toThrow(
        expect.objectContaining({ code: "unsupported_media_type", message: "Upload an MP4, MOV or WebM video." }),
      );
    },
  );

  it("refuses an own photo key as the intro video, and still refuses a foreign video first as not owned", () => {
    expect(() => parseProfilePatch({ intro_video_path: `${USER}/photo.jpg`, bio: "hi" }, USER)).toThrow(
      expect.objectContaining({ code: "unsupported_media_type" }),
    );
    expect(() => parseProfilePatch({ intro_video_path: "someone-else/v.mp4" }, USER)).toThrow(
      expect.objectContaining({ code: "media_not_owned" }),
    );
  });

  it.each(["mp4", "mov", "webm"])("accepts an own .%s upload", (ext) => {
    expect(parseProfilePatch({ intro_video_path: ` ${USER}/clip.${ext} ` }, USER)).toEqual({
      intro_video_path: `${USER}/clip.${ext}`,
    });
  });

  it("still clears the intro video with null", () => {
    expect(parseProfilePatch({ intro_video_path: null }, USER)).toEqual({ intro_video_path: null });
  });
});
