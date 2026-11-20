
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  mintInstallationToken: vi.fn(async () => "ghs_faketoken"),
  ghInstallationHeaders: vi.fn(() => ({ authorization: "Bearer ghs_faketoken" })),
  serviceClientMock: vi.fn(),
}));

vi.mock("@/services/connectors/github/oauth", () => ({
  mintInstallationToken: mocks.mintInstallationToken,
  ghInstallationHeaders: mocks.ghInstallationHeaders,
}));
vi.mock("@/services/supabase", () => ({ serviceClient: mocks.serviceClientMock }));

import { grepImpl, globToRegExp, numberLines, rankGrepCandidates } from "../github";

const CRON_DOC = [
  "# Cron jobs",
  "",
  "| Local | Expression | TZ | Job |",
  "| --- | --- | --- | --- |",
  ...Array.from(
    { length: 82 },
    (_, i) => `| **0${i % 10}:00** | \`0 ${i % 24} * * *\` | UTC | \`filler${i}Job\` |`,
  ),
  "| **09:30** | `30 16 * * *` | UTC | `scheduleProcessAggregatedPayoutsForAllHostsJob` |",
  "| **18:00** | `0 1 * * *` | UTC | `scheduleCronJobExecutionCleanup` |",
].join("\n");

function b64(s: string): string {
  return Buffer.from(s, "utf-8").toString("base64");
}

function installFetch(
  files: Record<string, string>,
  opts?: { treeTruncated?: boolean; sizes?: Record<string, number> },
) {
  const fetchMock = vi.fn(async (url: string) => {
    if (url.includes("/git/trees/")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          truncated: opts?.treeTruncated ?? false,
          tree: Object.entries(files).map(([path, body]) => ({
            path,
            type: "blob",
            size: opts?.sizes?.[path] ?? Buffer.byteLength(body, "utf-8"),
          })),
        }),
      } as unknown as Response;
    }
    const m = /\/contents\/([^?]+)/.exec(url);
    const path = m ? decodeURIComponent(m[1]) : "";
    const body = files[path];
    if (body === undefined) return { ok: false, status: 404 } as unknown as Response;
    return {
      ok: true,
      status: 200,
      json: async () => ({ type: "file", encoding: "base64", content: b64(body) }),
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const ARGS = {
  owner: "rravi149",
  repo: "upcar",
  ref: "HEAD",
  regex: true,
  case_sensitive: false,
  max_matches: 50,
} as const;

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("grep — the retrieval rail search_code could never be", () => {
  it("finds a cron expression by LINE NUMBER (the exact 8312a7ca miss)", async () => {
    installFetch({ "apps/backend/CRON_JOBS_SCHEDULE.md": CRON_DOC });

    const out = await grepImpl(1 as unknown as string, 42, {
      ...ARGS,
      pattern: String.raw`30 16 \* \* \*`,
    });

    expect(out.matches).toHaveLength(1);
    const hit = out.matches[0];
    expect(hit.path).toBe("apps/backend/CRON_JOBS_SCHEDULE.md");
    expect(hit.line_number).toBe(87);
    expect(hit.line).toContain("scheduleProcessAggregatedPayoutsForAllHosts");
    expect(out.complete).toBe(true);
  });

  it("matches punctuation literally when regex:false", async () => {
    installFetch({ "a.md": "x\n30 16 * * *\ny" });
    const out = await grepImpl(1 as unknown as string, 42, {
      ...ARGS,
      pattern: "30 16 * * *",
      regex: false,
    });
    expect(out.matches.map((m) => m.line_number)).toEqual([2]);
  });

  it("rejects an invalid regex with an actionable code instead of throwing raw", async () => {
    installFetch({ "a.md": "x" });
    await expect(
      grepImpl(1 as unknown as string, 42, { ...ARGS, pattern: "payout(" }),
    ).rejects.toMatchObject({ code: "bad_pattern" });
  });

  it("honours path_glob so a large repo can be narrowed", async () => {
    installFetch({
      "apps/backend/cron.ts": "payout schedule",
      "apps/web/cron.ts": "payout schedule",
    });
    const out = await grepImpl(1 as unknown as string, 42, {
      ...ARGS,
      pattern: "payout",
      path_glob: "apps/backend/**/*.ts",
    });
    expect(out.matches.map((m) => m.path)).toEqual(["apps/backend/cron.ts"]);
  });

  it("skips binary/asset paths rather than regexing image bytes", async () => {
    installFetch({ "logo.png": "payout", "notes.md": "payout" });
    const out = await grepImpl(1 as unknown as string, 42, { ...ARGS, pattern: "payout" });
    expect(out.matches.map((m) => m.path)).toEqual(["notes.md"]);
  });

  it("reports complete:false + a do-not-conclude-absence hint on a bounded scan", async () => {
    installFetch({ "a.md": "nothing here" }, { treeTruncated: true });
    const out = await grepImpl(1 as unknown as string, 42, { ...ARGS, pattern: "payout" });
    expect(out.matches).toHaveLength(0);
    expect(out.complete).toBe(false);
    expect(out.stopped_because).toBe("tree_truncated");
    expect(out.hint).toMatch(/NOT proof/i);
  });

  it("flags a max_matches cutoff as incomplete", async () => {
    installFetch({ "a.md": "hit\nhit\nhit\nhit" });
    const out = await grepImpl(1 as unknown as string, 42, {
      ...ARGS,
      pattern: "hit",
      max_matches: 2,
    });
    expect(out.matches).toHaveLength(2);
    expect(out.complete).toBe(false);
    expect(out.stopped_because).toBe("max_matches");
  });
});

describe("grep — bounds must never masquerade as a clean negative", () => {
  it("scans a file past 64KB in full and finds a match near its end", async () => {
    const filler = `${"x".repeat(99)}\n`.repeat(3000);
    installFetch({ "controller.ts": `${filler}const pipeline = [{ $geoNear: {} }];` });

    const out = await grepImpl(1 as unknown as string, 42, { ...ARGS, pattern: "geoNear" });

    expect(out.matches.map((m) => m.line_number)).toEqual([3001]);
    expect(out.complete).toBe(true);
    expect(out.partially_scanned_files).toBeUndefined();
  });

  it("does NOT report complete:true when a file's text is cut at the per-file scan cap", async () => {
    const filler = `${"x".repeat(99)}\n`.repeat(5300);
    installFetch({ "big.md": `${filler}30 16 * * * payout` }, { sizes: { "big.md": 1000 } });

    const out = await grepImpl(1 as unknown as string, 42, { ...ARGS, pattern: "payout" });

    expect(out.matches).toHaveLength(0);
    expect(out.complete).toBe(false);
    expect(out.stopped_because).toBe("file_truncated");
    expect(out.partially_scanned_files).toEqual(["big.md"]);
    expect(out.hint).toMatch(/NOT proof of absence/i);
  });

  it("reserves the byte budget before fetching so parallel workers cannot overshoot it", async () => {
    const big = `${"y".repeat(99)}\n`.repeat(5000);
    const files = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`f${i}.md`, big]));
    const fetchMock = installFetch(files);

    const out = await grepImpl(1 as unknown as string, 42, { ...ARGS, pattern: "zzz" });

    const contentFetches = fetchMock.mock.calls.filter(([u]) => String(u).includes("/contents/"));
    expect(contentFetches.length * 500_000).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(out.complete).toBe(false);
    expect(out.stopped_because).toBe("byte_budget");
  });

  it("rejects a nested-quantifier regex instead of pinning the worker", async () => {
    installFetch({ "a.md": "aaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
    await expect(
      grepImpl(1 as unknown as string, 42, { ...ARGS, pattern: "(a+)+$" }),
    ).rejects.toMatchObject({ code: "unsafe_pattern" });
  });

  it("keeps the tree_truncated reason instead of letting candidate_cap clobber it", async () => {
    installFetch({ "a.md": "nope" }, { treeTruncated: true });
    const out = await grepImpl(1 as unknown as string, 42, { ...ARGS, pattern: "zzz" });
    expect(out.stopped_because).toBe("tree_truncated");
  });
});

describe("globToRegExp", () => {
  it("makes `**/` span zero directories as well as many", () => {
    const re = globToRegExp("apps/backend/**/*.ts");
    expect(re.test("apps/backend/x.ts")).toBe(true);
    expect(re.test("apps/backend/a/b/x.ts")).toBe(true);
    expect(re.test("apps/web/x.ts")).toBe(false);
  });

  it("keeps `*` inside one segment and treats dots literally", () => {
    expect(globToRegExp("*.md").test("README.md")).toBe(true);
    expect(globToRegExp("*.md").test("docs/README.md")).toBe(false);
    expect(globToRegExp("a.md").test("axmd")).toBe(false);
  });
});

describe("numberLines — the anchor read_file never gave the model", () => {
  it("numbers from an arbitrary first line so region reads cite true numbers", () => {
    expect(numberLines("alpha\nbeta", 86)).toBe("86│alpha\n87│beta");
  });

  it("right-pads so columns align as the number widens", () => {
    expect(numberLines("a\nb", 9)).toBe(" 9│a\n10│b");
  });

  it("returns empty for an empty file rather than inventing a line 1", () => {
    expect(numberLines("", 1)).toBe("");
  });

  it("leaves the truncation marker unnumbered so it never reads as source", () => {
    const out = numberLines("real line\n[truncated 12 bytes]", 1);
    expect(out).toBe("1│real line\n[truncated 12 bytes]");
  });
});

describe("grep — reach past the first window", () => {
  function bigRepo(n: number, extra: Record<string, string>): Record<string, string> {
    const files: Record<string, string> = {};
    for (let i = 0; i < n; i++) files[`a-early/f${String(i).padStart(4, "0")}.ts`] = "nothing here";
    return { ...files, ...extra };
  }

  it("ranks source before docs before tests, and pattern-named paths first", () => {
    const ranked = rankGrepCandidates(
      [
        { path: "apps/x/__tests__/deposit.test.ts" },
        { path: "docs/notes.md" },
        { path: "apps/x/billing.ts" },
        { path: "apps/x/depositService.ts" },
        { path: "apps/x/dist/deposit.js" },
      ],
      "deposit",
      true,
    ).map((c) => c.path);
    expect(ranked).toEqual([
      "apps/x/depositService.ts",
      "apps/x/billing.ts",
      "docs/notes.md",
      "apps/x/__tests__/deposit.test.ts",
      "apps/x/dist/deposit.js",
    ]);
  });

  it("finds a match in a pattern-named file the alphabetical window never reached", async () => {
    installFetch(bigRepo(400, { "z-late/securityDeposit.ts": "const AMOUNT = 200; // securityDeposit" }));
    const out = await grepImpl(1 as unknown as string, 42, { ...ARGS, pattern: "securityDeposit" });
    expect(out.matches.map((m) => m.path)).toContain("z-late/securityDeposit.ts");
  });

  it("returns a next_cursor that continues instead of re-scanning", async () => {
    installFetch(bigRepo(650, { "z-late/thing.ts": "needle" }));
    const first = await grepImpl(1 as unknown as string, 42, { ...ARGS, pattern: "needle" });
    expect(first.complete).toBe(false);
    expect(first.stopped_because).toBe("candidate_cap");
    expect(first.matches).toEqual([]);
    expect(first.next_cursor).toMatch(/^v1\.[0-9a-f]{12}\.300$/);
    expect(first.hint).toContain(first.next_cursor);

    const second = await grepImpl(1 as unknown as string, 42, { ...ARGS, pattern: "needle", cursor: first.next_cursor });
    expect(second.scanned_range).toEqual([300, 600]);
    const third = await grepImpl(1 as unknown as string, 42, { ...ARGS, pattern: "needle", cursor: second.next_cursor });
    expect(third.scanned_range).toEqual([600, 651]);
    expect(third.complete).toBe(true);
    expect(third.next_cursor).toBeUndefined();
    expect(third.matches.map((m) => m.path)).toEqual(["z-late/thing.ts"]);
  });

  it("restarts from the top when the cursor belongs to a different query", async () => {
    installFetch(bigRepo(650, {}));
    const first = await grepImpl(1 as unknown as string, 42, { ...ARGS, pattern: "needle" });
    const other = await grepImpl(1 as unknown as string, 42, { ...ARGS, pattern: "other", cursor: first.next_cursor });
    expect(other.cursor_reset).toBe(true);
    expect(other.scanned_range).toEqual([0, 300]);
  });

  it("gives no cursor when it stopped on max_matches", async () => {
    installFetch(bigRepo(650, {}));
    const out = await grepImpl(1 as unknown as string, 42, { ...ARGS, pattern: "nothing", max_matches: 3 });
    expect(out.matches).toHaveLength(3);
    expect(out.next_cursor).toBeUndefined();
  });

  it("marks a scan incomplete when a file could not be read, and carries the gap forward", async () => {
    const files = bigRepo(650, { "z-late/thing.ts": "needle" });
    const fetchMock = installFetch(files);
    const real = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string) =>
      decodeURIComponent(url).includes("/contents/a-early/f0005.ts") ? ({ ok: false, status: 500 } as unknown as Response) : real(url),
    );
    const first = await grepImpl(1 as unknown as string, 42, { ...ARGS, pattern: "needle" });
    expect(first.unread_files).toContain("a-early/f0005.ts");
    expect(first.next_cursor).toMatch(/\.p$/);
    const second = await grepImpl(1 as unknown as string, 42, { ...ARGS, pattern: "needle", cursor: first.next_cursor });
    const third = await grepImpl(1 as unknown as string, 42, { ...ARGS, pattern: "needle", cursor: second.next_cursor });
    expect(third.matches.map((m) => m.path)).toEqual(["z-late/thing.ts"]);
    expect(third.complete).toBe(false);
    expect(third.stopped_because).toBe("earlier_page_partial");
  });
});
