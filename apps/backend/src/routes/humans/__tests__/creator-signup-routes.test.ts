
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const USER = "11111111-0000-4000-8000-000000000011";
const MEMBER_ID = "55555555-0000-4000-8000-000000000055";

type Result = { data: unknown; error: { code?: string; message?: string } | null };
type Call = { table: string; ops: Array<{ op: string; args: unknown[] }> };

const { verifyBearerMock } = vi.hoisted(() => ({
  verifyBearerMock: vi.fn(),
}));
vi.mock("@/services/auth/jwt", () => ({ verifyBearer: verifyBearerMock }));

const { globalClientMock, storageMock, state, calls, signedPaths } = vi.hoisted(() => {
  const c: { list: Call[] } = { list: [] };
  const s: { queues: Record<string, Result[]> } = { queues: {} };
  const paths: string[] = [];
  const CHAIN = [
    "select", "eq", "neq", "ilike", "like", "in", "not", "order", "range", "limit",
    "insert", "update", "delete", "upsert",
  ];
  const client = {
    from(table: string) {
      const call: Call = { table, ops: [] };
      c.list.push(call);
      const result = (): Result => {
        const q = s.queues[table];
        if (!q?.length) return { data: null, error: null };
        return q.length > 1 ? q.shift()! : q[0];
      };
      const b: Record<string, unknown> = {};
      for (const op of CHAIN) {
        b[op] = (...args: unknown[]) => {
          call.ops.push({ op, args });
          return b;
        };
      }
      b.maybeSingle = () => Promise.resolve(result());
      b.single = () => Promise.resolve(result());
      b.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve(result()).then(onF, onR);
      return b;
    },
  };
  return {
    globalClientMock: vi.fn(() => client),
    storageMock: vi.fn(() => ({
      from: () => ({
        createSignedUploadUrl: async (path: string) => {
          paths.push(path);
          return { data: { path, token: "tok", signedUrl: `https://storage.test/${path}` }, error: null };
        },
      }),
    })),
    state: s,
    calls: c,
    signedPaths: paths,
  };
});
vi.mock("@/services/tenant-client", () => ({
  globalClient: globalClientMock,
  humanApplicantStorage: storageMock,
}));

import {
  generateCreatorSlug,
  swapMemberHandles,
  writeWithFreshSlug,
} from "@/services/humans/store";
import { postMediaUploadUrl } from "../creator-signup";

function mockRes() {
  const r: Record<string, unknown> = { statusCode: 200 };
  r.status = (c: number) => {
    r.statusCode = c;
    return r;
  };
  r.json = (b: unknown) => {
    r.body = b;
    return r;
  };
  return r as unknown as Response & { statusCode: number; body: Record<string, unknown> };
}

function opsFor(table: string, op: string): unknown[][] {
  return calls.list
    .filter((c) => c.table === table)
    .flatMap((c) => c.ops.filter((o) => o.op === op).map((o) => o.args));
}

beforeEach(() => {
  calls.list = [];
  state.queues = {};
  signedPaths.length = 0;
  verifyBearerMock.mockReset();
  verifyBearerMock.mockResolvedValue({
    user_id: USER,
    access_token: "tok",
    email: "jules@example.com",
    session_id: null,
    claim_tenant_id: null,
  });
});

describe("server-generated slug", () => {
  it("uses the display name when it is free", async () => {
    state.queues.human_members = [{ data: [], error: null }];
    expect(await generateCreatorSlug("Jules Makes")).toBe("jules-makes");
    expect(opsFor("human_members", "like")).toContainEqual(["slug", "jules-makes%"]);
  });

  it("adds the next free numeric suffix when the base is taken", async () => {
    state.queues.human_members = [
      { data: [{ slug: "jules-makes" }, { slug: "jules-makes-2" }], error: null },
    ];
    expect(await generateCreatorSlug("Jules Makes")).toBe("jules-makes-3");
  });

  it("never produces a reserved name", async () => {
    state.queues.human_members = [{ data: [], error: null }];
    expect(await generateCreatorSlug("Admin")).toBe("new-creator");
  });
});

describe("slug race: retry with a random suffix, never a duplicate_slug error", () => {
  const SLUG_CHECK = /^[a-z0-9][a-z0-9_-]{1,38}[a-z0-9]$/;
  const race = { data: null, error: { code: "23505", message: 'duplicate key value violates unique constraint "human_members_slug_key"' } };
  const won = { data: { id: MEMBER_ID }, error: null };
  type Chain = { insert: (r: unknown) => Chain; select: (c: string) => Chain; single: () => Promise<{ data: unknown; error: { code?: string; message?: string } | null }> };
  const insert = (slug: string) =>
    (globalClientMock() as unknown as { from: (t: string) => Chain }).from("human_members").insert({ slug }).select("id").single();
  const insertedSlugs = () =>
    opsFor("human_members", "insert").map((a) => (a[0] as Record<string, unknown>).slug as string);

  it("two concurrent losers both retry and land on DIFFERENT valid slugs", async () => {
    const rnd = vi.spyOn(Math, "random").mockReturnValueOnce(0.123).mockReturnValueOnce(0.456);
    state.queues.human_members = [{ data: [], error: null }, race, won];
    await writeWithFreshSlug("julesmakes", insert);
    state.queues.human_members = [{ data: [], error: null }, race, won];
    await writeWithFreshSlug("julesmakes", insert);
    const slugs = insertedSlugs();
    expect(slugs[0]).toBe("julesmakes");
    expect(slugs[2]).toBe("julesmakes");
    const retries = [slugs[1], slugs[3]];
    for (const s of retries) {
      expect(s).toMatch(/^julesmakes-\d{5}$/);
      expect(s).toMatch(SLUG_CHECK);
    }
    expect(retries[0]).not.toBe(retries[1]);
    rnd.mockRestore();
  });

  it("a long name still fits the slug CHECK after the random suffix", async () => {
    state.queues.human_members = [{ data: [], error: null }, race, won];
    await writeWithFreshSlug("a".repeat(120), insert);
    expect(insertedSlugs()[1]).toMatch(SLUG_CHECK);
  });

  it("out of retries is a store error (503), not duplicate_slug", async () => {
    state.queues.human_members = [{ data: [], error: null }, race];
    await expect(writeWithFreshSlug("julesmakes", insert)).rejects.toMatchObject({ code: "human_store_error", status: 503 });
  });
});

describe("handle swap never leaves a creator with no accounts", () => {
  it("a taken new handle fails the insert BEFORE any existing handle is deleted", async () => {
    state.queues.human_member_handles = [
      { data: [{ id: "h1", platform: "tiktok", handle: "maya" }], error: null },
      { data: null, error: { code: "23505", message: "duplicate key" } },
    ];
    await expect(
      swapMemberHandles(MEMBER_ID, [
        { platform: "tiktok", handle: "maya", followers: 100 },
        { platform: "instagram", handle: "taken", followers: 50 },
      ]),
    ).rejects.toBeTruthy();
    expect(opsFor("human_member_handles", "insert")[0][0]).toEqual([
      { human_member_id: MEMBER_ID, platform: "instagram", handle: "taken", followers: 50 },
    ]);
    expect(opsFor("human_member_handles", "delete")).toEqual([]);
  });

  it("keeps a re-saved handle, inserts the new one, then deletes only the dropped one", async () => {
    state.queues.human_member_handles = [
      {
        data: [
          { id: "h1", platform: "tiktok", handle: "Maya" },
          { id: "h2", platform: "youtube", handle: "old" },
        ],
        error: null,
      },
      { data: null, error: null },
    ];
    await swapMemberHandles(MEMBER_ID, [
      { platform: "tiktok", handle: "maya", followers: 100 },
      { platform: "instagram", handle: "new", followers: 50 },
    ]);
    const order = calls.list.filter((c) => c.table === "human_member_handles").map((c) => c.ops.find((o) => o.op !== "select" && o.op !== "eq" && o.op !== "in")?.op ?? "select");
    expect(order).toEqual(["select", "insert", "update", "delete"]);
    expect(opsFor("human_member_handles", "insert")[0][0]).toEqual([
      { human_member_id: MEMBER_ID, platform: "instagram", handle: "new", followers: 50 },
    ]);
    expect(opsFor("human_member_handles", "update")[0][0]).toEqual({ handle: "maya", followers: 100 });
    expect(opsFor("human_member_handles", "in")).toContainEqual(["id", ["h2"]]);
  });
});

describe("POST /api/humans/media-upload-url", () => {
  it("requires a bearer — an upload URL is not step 1", async () => {
    verifyBearerMock.mockResolvedValue(null);
    const res = mockRes();
    await postMediaUploadUrl({ headers: {}, body: { kind: "intro", content_type: "video/mp4" } } as unknown as Request, res);
    expect(res.statusCode).toBe(401);
    expect(signedPaths).toEqual([]);
  });

  it("mints a key under the VERIFIED sub, ignoring anything the caller sent", async () => {
    const res = mockRes();
    await postMediaUploadUrl(
      {
        headers: {},
        body: {
          kind: "intro",
          content_type: "video/quicktime",
          path: "someone-else/steal.mov",
          human_member_id: MEMBER_ID,
          bucket: "creator-deliverables",
        },
      } as unknown as Request,
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(signedPaths).toHaveLength(1);
    expect(signedPaths[0].startsWith(`${USER}/`)).toBe(true);
    expect(signedPaths[0].endsWith(".mov")).toBe(true);
    expect(signedPaths[0]).not.toContain("steal");
    expect(res.body.bucket).toBe("creator-media");
  });

  it("refuses a non-video type, so nothing but video reaches a public bucket", async () => {
    for (const type of ["image/png", "application/pdf", "text/html", ""]) {
      const res = mockRes();
      await postMediaUploadUrl({ headers: {}, body: { kind: "sample", content_type: type } } as unknown as Request, res);
      expect(res.statusCode, type).toBe(400);
    }
    expect(signedPaths).toEqual([]);
  });

  it("photo kind: accepts only JPG, PNG and WebP, and mints an image key under the verified sub", async () => {
    for (const [type, ext] of [
      ["image/jpeg", "jpg"],
      ["image/png", "png"],
      ["image/webp", "webp"],
    ] as const) {
      const res = mockRes();
      await postMediaUploadUrl(
        { headers: {}, body: { kind: "photo", content_type: type, size_bytes: 1024 } } as unknown as Request,
        res,
      );
      expect(res.statusCode, type).toBe(200);
      expect(res.body.max_bytes).toBe(5 * 1024 * 1024);
      const last = signedPaths[signedPaths.length - 1];
      expect(last.startsWith(`${USER}/`)).toBe(true);
      expect(last.endsWith(`.${ext}`)).toBe(true);
    }
    signedPaths.length = 0;
    for (const type of ["video/mp4", "image/gif", "image/svg+xml", "application/pdf", ""]) {
      const res = mockRes();
      await postMediaUploadUrl({ headers: {}, body: { kind: "photo", content_type: type } } as unknown as Request, res);
      expect(res.statusCode, type).toBe(400);
    }
    expect(signedPaths).toEqual([]);
  });

  it("photo kind: refuses a file over 5 MB, allows exactly 5 MB", async () => {
    const over = mockRes();
    await postMediaUploadUrl(
      { headers: {}, body: { kind: "photo", content_type: "image/png", size_bytes: 5 * 1024 * 1024 + 1 } } as unknown as Request,
      over,
    );
    expect(over.statusCode).toBe(413);
    expect(signedPaths).toEqual([]);
    const exact = mockRes();
    await postMediaUploadUrl(
      { headers: {}, body: { kind: "photo", content_type: "image/png", size_bytes: 5 * 1024 * 1024 } } as unknown as Request,
      exact,
    );
    expect(exact.statusCode).toBe(200);
  });

  it("refuses an unknown kind", async () => {
    const res = mockRes();
    await postMediaUploadUrl({ headers: {}, body: { kind: "deliverable", content_type: "video/mp4" } } as unknown as Request, res);
    expect(res.statusCode).toBe(400);
    expect(signedPaths).toEqual([]);
  });
});
