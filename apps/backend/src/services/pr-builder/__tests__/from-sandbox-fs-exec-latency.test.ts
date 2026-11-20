import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/services/sandbox/e2b-client", () => ({ execCommand: vi.fn() }));

import {
  buildPrFilesFromSandboxFs,
  BuilderRejectedError,
  PRODUCT_BUILD_BUILDER_CAPS,
} from "../from-sandbox-fs";
import { execCommand } from "@/services/sandbox/e2b-client";

const execMock = vi.mocked(execCommand);

type FakeFile = { status: "??" | " M" | " D"; content?: string; diff?: string; head?: string };

function latencyFor(command: string): number {
  let h = 0;
  for (const ch of command) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return 400 + (h % 800);
}

function quotedPath(command: string): string {
  const m = command.match(/'([^']*)'\s*$/) ?? command.match(/HEAD:'([^']*)'/);
  return m ? m[1]! : "";
}

function installFakeSandbox(
  tree: Map<string, FakeFile>,
  opts: { failCat?: Map<string, number> } = {},
) {
  let inFlight = 0;
  const stats = { calls: 0, maxInFlight: 0, finished: [] as string[] };
  execMock.mockImplementation(async (_sbx, command) => {
    stats.calls += 1;
    inFlight += 1;
    stats.maxInFlight = Math.max(stats.maxInFlight, inFlight);
    const path = quotedPath(command);
    const failDelay = opts.failCat?.get(path);
    const delay = failDelay ?? latencyFor(command);
    await new Promise((r) => setTimeout(r, delay));
    inFlight -= 1;
    if (path !== "") stats.finished.push(path);
    const ok = (stdout: string) => ({ stdout, stderr: "", exit_code: 0, ms: delay });
    if (command.includes("git status --porcelain")) {
      return ok([...tree].map(([p, f]) => `${f.status} ${p}`).join("\0") + "\0");
    }
    if (command.includes("--numstat")) {
      return ok(
        [...tree]
          .filter(([, f]) => f.status === " M")
          .map(([p]) => `2\t1\t${p}`)
          .join("\n"),
      );
    }
    if (failDelay !== undefined && command.includes("&& cat ")) {
      return { stdout: "", stderr: `cat: ${path}: denied`, exit_code: 1, ms: delay };
    }
    const f = tree.get(path);
    if (command.includes("git cat-file -p HEAD:")) return ok(f?.head ?? "");
    if (command.includes("git diff --no-ext-diff HEAD --")) return ok(f?.diff ?? "");
    if (command.includes("&& cat ")) return ok(f?.content ?? "");
    throw new Error(`unexpected command: ${command}`);
  });
  return stats;
}

function nextBuildFixture(): Map<string, FakeFile> {
  const tree = new Map<string, FakeFile>();
  for (let i = 0; i < 31; i++) {
    tree.set(`src/app/page-${i}/page.tsx`, {
      status: "??",
      content: `export default function P${i}() {\n  return <main>${i}</main>;\n}\n`,
    });
  }
  for (let i = 0; i < 8; i++) {
    tree.set(`src/lib/mod-${i}.ts`, {
      status: " M",
      content: `export const v${i} = ${i + 1};\n`,
      diff: `diff --git a/src/lib/mod-${i}.ts b/src/lib/mod-${i}.ts\n@@ -1 +1 @@\n-export const v${i} = ${i};\n+export const v${i} = ${i + 1};\n`,
    });
  }
  tree.set("src/legacy.ts", { status: " D", head: "export const legacy = 1;\n" });
  return tree;
}

function expectedDiff(path: string, f: FakeFile): string {
  if (f.status === " M") return f.diff ?? "";
  const lines = ((f.status === "??" ? f.content : f.head) ?? "").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return f.status === "??"
    ? [
        `diff --git a/${path} b/${path}`,
        "new file mode 100644",
        "--- /dev/null",
        `+++ b/${path}`,
        `@@ -0,0 +1,${lines.length} @@`,
        ...lines.map((l) => `+${l}`),
        "",
      ].join("\n")
    : [
        `diff --git a/${path} b/${path}`,
        "deleted file mode 100644",
        `--- a/${path}`,
        "+++ /dev/null",
        `@@ -1,${lines.length} +0,0 @@`,
        ...lines.map((l) => `-${l}`),
        "",
      ].join("\n");
}

async function runOnFakeClock<T>(p: Promise<T>): Promise<{ value?: T; error?: unknown; elapsedMs: number }> {
  const start = Date.now();
  let settled = false;
  let value: T | undefined;
  let error: unknown;
  p.then(
    (v) => {
      settled = true;
      value = v;
    },
    (e) => {
      settled = true;
      error = e;
    },
  );
  for (let i = 0; i < 10_000 && !settled; i++) {
    await vi.advanceTimersByTimeAsync(50);
  }
  if (!settled) throw new Error("builder never settled on the fake clock");
  return { value, error, elapsedMs: Date.now() - start };
}

beforeEach(() => {
  execMock.mockReset();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("buildPrFilesFromSandboxFs sandbox exec latency", () => {
  it("reads a 40-file first-build diff in a fraction of the serial wall-clock, same files in porcelain order", async () => {
    const tree = nextBuildFixture();
    const stats = installFakeSandbox(tree);
    const { value, error, elapsedMs } = await runOnFakeClock(
      buildPrFilesFromSandboxFs({ sandbox_id: "sbx", caps: PRODUCT_BUILD_BUILDER_CAPS }),
    );
    expect(error).toBeUndefined();
    expect(stats.calls).toBe(1 + 31 + 8 * 2 + 1 + 1);
    const serialMs = 50 * 800;
    expect(elapsedMs).toBeLessThan(serialMs / 3);
    expect(value!.files.map((f) => f.path)).toEqual([...tree.keys()]);
    expect(value!.files[0]).toEqual({
      path: "src/app/page-0/page.tsx",
      action: "create",
      diff: [
        "diff --git a/src/app/page-0/page.tsx b/src/app/page-0/page.tsx",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/src/app/page-0/page.tsx",
        "@@ -0,0 +1,3 @@",
        "+export default function P0() {",
        "+  return <main>0</main>;",
        "+}",
        "",
      ].join("\n"),
      content: "export default function P0() {\n  return <main>0</main>;\n}\n",
    });
    expect(value!.files[31]).toEqual({
      path: "src/lib/mod-0.ts",
      action: "modify",
      diff: tree.get("src/lib/mod-0.ts")!.diff,
      content: "export const v0 = 1;\n",
    });
    expect(value!.files[39]!.action).toBe("delete");
    expect(value!.files[39]!.content).toBeUndefined();
    expect(value!.files[39]!.diff).toContain("-export const legacy = 1;");
    expect(value!.total_changed_lines).toBe(8 * 3 + 31 * 3);
  });

  it("never has more than 8 sandbox execs in flight at once (non-regression guard: passes serially too)", async () => {
    const stats = installFakeSandbox(nextBuildFixture());
    await runOnFakeClock(
      buildPrFilesFromSandboxFs({ sandbox_id: "sbx", caps: PRODUCT_BUILD_BUILDER_CAPS }),
    );
    expect(stats.maxInFlight).toBeLessThanOrEqual(8);
  });

  it("throws the FIRST failing file in porcelain order even when a later file fails sooner (non-regression guard)", async () => {
    const tree = nextBuildFixture();
    installFakeSandbox(tree, {
      failCat: new Map([
        ["src/app/page-3/page.tsx", 1_500],
        ["src/app/page-5/page.tsx", 10],
      ]),
    });
    const { error } = await runOnFakeClock(
      buildPrFilesFromSandboxFs({ sandbox_id: "sbx", caps: PRODUCT_BUILD_BUILDER_CAPS }),
    );
    expect(error).toBeInstanceOf(BuilderRejectedError);
    expect((error as BuilderRejectedError).detail).toMatchObject({
      kind: "git_diff_failed",
      path: "src/app/page-3/page.tsx",
    });
  });

  it("stops starting new reads after a failure instead of reading the whole tree", async () => {
    const tree = nextBuildFixture();
    const stats = installFakeSandbox(tree, {
      failCat: new Map([["src/app/page-0/page.tsx", 10]]),
    });
    const { error } = await runOnFakeClock(
      buildPrFilesFromSandboxFs({ sandbox_id: "sbx", caps: PRODUCT_BUILD_BUILDER_CAPS }),
    );
    expect(error).toBeInstanceOf(BuilderRejectedError);
    expect(stats.calls).toBeLessThanOrEqual(1 + 8 + 1);
  });

  it("propagates a thrown exec (sandbox gone) instead of returning a partial diff", async () => {
    const tree = nextBuildFixture();
    installFakeSandbox(tree);
    const base = execMock.getMockImplementation()!;
    execMock.mockImplementation(async (sbx, command, timeout) => {
      if (command.includes("src/lib/mod-2.ts") && command.includes("git diff")) {
        await new Promise((r) => setTimeout(r, 200));
        throw new Error("sandbox not found");
      }
      return base(sbx, command, timeout);
    });
    const { value, error } = await runOnFakeClock(
      buildPrFilesFromSandboxFs({ sandbox_id: "sbx", caps: PRODUCT_BUILD_BUILDER_CAPS }),
    );
    expect(value).toBeUndefined();
    expect((error as Error).message).toBe("sandbox not found");
  });
});

describe("buildPrFilesFromSandboxFs gates and caps with batched reads", () => {
  it("refuses a forbidden path at the end of a 41-file tree before a single file read", async () => {
    const tree = nextBuildFixture();
    tree.set(".env.production", { status: "??", content: "SECRET=1\n" });
    const stats = installFakeSandbox(tree);
    const { value, error } = await runOnFakeClock(
      buildPrFilesFromSandboxFs({ sandbox_id: "sbx", caps: PRODUCT_BUILD_BUILDER_CAPS, site_repo: true }),
    );
    expect(value).toBeUndefined();
    expect((error as BuilderRejectedError).detail).toEqual({
      kind: "forbidden_path",
      path: ".env.production",
      paths: [".env.production"],
    });
    expect(stats.calls).toBe(1);
  });

  it("refuses a site migration without the site flag and ships it in porcelain order with the flag", async () => {
    const sql = "create table if not exists public.bookings (id uuid primary key);\n";
    const tree = new Map<string, FakeFile>([
      ["supabase/migrations/0001_init.sql", { status: "??", content: sql }],
      ...nextBuildFixture(),
    ]);

    const refusedStats = installFakeSandbox(tree);
    const refused = await runOnFakeClock(
      buildPrFilesFromSandboxFs({ sandbox_id: "sbx", caps: PRODUCT_BUILD_BUILDER_CAPS }),
    );
    expect(refused.value).toBeUndefined();
    expect((refused.error as BuilderRejectedError).detail).toEqual({
      kind: "forbidden_path",
      path: "supabase/migrations/0001_init.sql",
      paths: ["supabase/migrations/0001_init.sql"],
    });
    expect(refusedStats.calls).toBe(1);

    const shippedStats = installFakeSandbox(tree);
    const shipped = await runOnFakeClock(
      buildPrFilesFromSandboxFs({ sandbox_id: "sbx", caps: PRODUCT_BUILD_BUILDER_CAPS, site_repo: true }),
    );
    expect(shipped.error).toBeUndefined();
    expect(shipped.value!.files.map((f) => f.path)).toEqual([...tree.keys()]);
    expect(shipped.value!.files[0]).toEqual({
      path: "supabase/migrations/0001_init.sql",
      action: "create",
      diff: expectedDiff("supabase/migrations/0001_init.sql", tree.get("supabase/migrations/0001_init.sql")!),
      content: sql,
    });
    expect(shippedStats.calls).toBe(1 + 32 + 8 * 2 + 1 + 1);
  });

  it("a site repo still refuses a nested migration, a deleted migration and a workflow file, names all three, and reads nothing", async () => {
    const tree = nextBuildFixture();
    tree.set("supabase/migrations/nested/0002.sql", { status: "??", content: "select 1;\n" });
    tree.set("supabase/migrations/0001_init.sql", { status: " D", head: "select 1;\n" });
    tree.set(".github/workflows/deploy.yml", { status: "??", content: "on: push\n" });
    const stats = installFakeSandbox(tree);
    const { value, error } = await runOnFakeClock(
      buildPrFilesFromSandboxFs({ sandbox_id: "sbx", caps: PRODUCT_BUILD_BUILDER_CAPS, site_repo: true }),
    );
    expect(value).toBeUndefined();
    expect((error as BuilderRejectedError).detail).toEqual({
      kind: "forbidden_path",
      path: "supabase/migrations/nested/0002.sql",
      paths: [
        "supabase/migrations/nested/0002.sql",
        "supabase/migrations/0001_init.sql",
        ".github/workflows/deploy.yml",
      ],
    });
    expect(stats.calls).toBe(1);
  });

  it("refuses on the file-count cap before a single file read", async () => {
    const stats = installFakeSandbox(nextBuildFixture());
    const { value, error } = await runOnFakeClock(
      buildPrFilesFromSandboxFs({
        sandbox_id: "sbx",
        caps: { ...PRODUCT_BUILD_BUILDER_CAPS, maxFiles: 39 },
      }),
    );
    expect(value).toBeUndefined();
    expect((error as BuilderRejectedError).detail).toEqual({
      kind: "max_files_exceeded",
      total_files: 40,
      cap: 39,
    });
    expect(stats.calls).toBe(1);
  });

  it("sums diff and post-image bytes to the serial totals although reads finish out of porcelain order", async () => {
    const tree = nextBuildFixture();
    tree.set("src/i18n/hi.ts", { status: "??", content: 'export const hello = "नमस्ते ₹";\n' });
    const diffs = [...tree].map(([p, f]) => expectedDiff(p, f));
    const diffBytes = diffs.reduce((n, d) => n + Buffer.byteLength(d, "utf-8"), 0);
    const postBytes = [...tree.values()].reduce(
      (n, f) => n + (f.status === " D" ? 0 : Buffer.byteLength(f.content ?? "", "utf-8")),
      0,
    );
    expect(postBytes).toBeGreaterThan([...tree.values()].reduce((n, f) => n + (f.content ?? "").length, 0));

    const stats = installFakeSandbox(tree);
    const exact = await runOnFakeClock(
      buildPrFilesFromSandboxFs({
        sandbox_id: "sbx",
        caps: { ...PRODUCT_BUILD_BUILDER_CAPS, diffByteCap: diffBytes, maxPostImageBytes: postBytes },
      }),
    );
    expect(exact.error).toBeUndefined();
    expect(exact.value!.files.map((f) => f.path)).toEqual([...tree.keys()]);
    expect(exact.value!.files.map((f) => f.diff)).toEqual(diffs);
    expect(exact.value!.total_diff_bytes).toBe(diffBytes);
    expect(exact.value!.total_post_image_bytes).toBe(postBytes);

    installFakeSandbox(tree);
    const overDiff = await runOnFakeClock(
      buildPrFilesFromSandboxFs({
        sandbox_id: "sbx",
        caps: { ...PRODUCT_BUILD_BUILDER_CAPS, diffByteCap: diffBytes - 1, maxPostImageBytes: postBytes },
      }),
    );
    expect(overDiff.value).toBeUndefined();
    expect((overDiff.error as BuilderRejectedError).detail).toEqual({
      kind: "diff_byte_cap_exceeded",
      total_diff_bytes: diffBytes,
      cap: diffBytes - 1,
    });

    installFakeSandbox(tree);
    const overPost = await runOnFakeClock(
      buildPrFilesFromSandboxFs({
        sandbox_id: "sbx",
        caps: { ...PRODUCT_BUILD_BUILDER_CAPS, diffByteCap: diffBytes, maxPostImageBytes: postBytes - 1 },
      }),
    );
    expect(overPost.value).toBeUndefined();
    expect((overPost.error as BuilderRejectedError).detail).toEqual({
      kind: "max_post_image_bytes_exceeded",
      total_post_image_bytes: postBytes,
      cap: postBytes - 1,
    });

    expect([...new Set(stats.finished)]).not.toEqual([...tree.keys()]);
  });

  it("reports the failed read, not the cap, when a tree over the byte cap also has an unreadable file", async () => {
    const tree = nextBuildFixture();
    installFakeSandbox(tree, { failCat: new Map([["src/app/page-7/page.tsx", 900]]) });
    const { value, error } = await runOnFakeClock(
      buildPrFilesFromSandboxFs({
        sandbox_id: "sbx",
        caps: { ...PRODUCT_BUILD_BUILDER_CAPS, diffByteCap: 1, maxPostImageBytes: 1 },
      }),
    );
    expect(value).toBeUndefined();
    expect((error as BuilderRejectedError).detail).toEqual({
      kind: "git_diff_failed",
      path: "src/app/page-7/page.tsx",
      stderr: "cat: src/app/page-7/page.tsx: denied",
    });
  });
});
