import { describe, it, expect, vi, beforeEach } from "vitest";

const runDistill = vi.fn(async (_input: Record<string, unknown>) => ({
  written: 1,
  skipped: 0,
  tokens: { input: 1, output: 1 },
}));
vi.mock("@/services/memory/distill", () => ({
  runDistill: (input: Record<string, unknown>) => runDistill(input),
}));

const assertTenantConnectedRepo = vi.fn(
  async (_tenant_id: string, _repo: string): Promise<void> => undefined,
);
vi.mock("@/services/sandbox/repo-profiles", () => ({
  assertTenantConnectedRepo: (tenant_id: string, repo: string) =>
    assertTenantConnectedRepo(tenant_id, repo),
}));
const getRepoInstallationToken = vi.fn(
  async (_a: { tenant_id: string; repo_full_name: string }): Promise<
    string | null
  > => "tok123",
);
vi.mock("@/services/connectors/github/oauth", () => ({
  getRepoInstallationToken: (a: { tenant_id: string; repo_full_name: string }) =>
    getRepoInstallationToken(a),
  ghInstallationHeaders: () => ({ authorization: "token tok123" }),
}));
vi.mock("@/services/agents/prompt-injection", () => ({
  renderUntrustedBlock: (label: string, raw: string) =>
    `<untrusted_${label}>${raw}</untrusted_${label}>`,
}));

const getScopedRepoFullNames = vi.fn(
  async (_tenant_id: string): Promise<string[]> => ["o/r"],
);
vi.mock("@/services/connectors/github/scoped-repos", () => ({
  getScopedRepoFullNames: (tenant_id: string) =>
    getScopedRepoFullNames(tenant_id),
}));

let conventionRows: Array<{ title: string; body_markdown: string }> = [];
let memoryNoteError: { message: string } | null = null;
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      if (table === "memory_note") {
        const chain: Record<string, unknown> = {};
        const pass = () => chain;
        chain.select = pass;
        chain.eq = pass;
        chain.is = pass;
        chain.contains = pass;
        chain.order = pass;
        chain.limit = () =>
          Promise.resolve({ data: conventionRows, error: memoryNoteError });
        return chain;
      }
      throw new Error(`UNEXPECTED TABLE: ${table}`);
    },
  }),
}));

import {
  distillRepoConventionsFromMergedPr,
  readRepoConventions,
} from "../repo-conventions";

const realFetch = globalThis.fetch;
beforeEach(() => {
  runDistill.mockClear();
  assertTenantConnectedRepo.mockClear();
  getRepoInstallationToken.mockClear();
  getScopedRepoFullNames.mockClear();
  getScopedRepoFullNames.mockResolvedValue(["o/r"]);
  conventionRows = [];
  memoryNoteError = null;
  globalThis.fetch = realFetch;
});

function mockGithub(diff: string, reviews: unknown[], comments: unknown[]) {
  globalThis.fetch = vi.fn(async (url: string | URL) => {
    const u = String(url);
    if (u.endsWith("/reviews?per_page=100")) {
      return { ok: true, json: async () => reviews } as unknown as Response;
    }
    if (u.endsWith("/comments?per_page=100")) {
      return { ok: true, json: async () => comments } as unknown as Response;
    }
    return { ok: true, text: async () => diff } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe("distillRepoConventionsFromMergedPr (P1-4)", () => {
  it("asserts the cross-tenant guard FIRST, then distills with the poisoning guard + per-repo tags", async () => {
    mockGithub(
      "diff --git a/x.ts b/x.ts\n+const a = 1;",
      [{ body: "target development not main", user: { type: "User" } }],
      [{ body: "no narration comments please", path: "x.ts", user: { type: "User" } }],
    );
    const res = await distillRepoConventionsFromMergedPr({
      tenant_id: "t1",
      repo_full_name: "o/r",
      pull_number: 9,
      pr_url: "https://github.com/o/r/pull/9",
    });
    expect(res).toEqual({ written: 1, skipped: 0 });
    expect(assertTenantConnectedRepo).toHaveBeenCalledWith("t1", "o/r");
    expect(runDistill).toHaveBeenCalledTimes(1);
    const arg = runDistill.mock.calls[0][0] as {
      dropUnverifiedAbsenceFacts?: boolean;
      baseTags: string[];
      userPrompt: string;
      tenant_id: string;
    };
    expect(arg.dropUnverifiedAbsenceFacts).toBe(true);
    expect(arg.baseTags).toContain("repo:o/r");
    expect(arg.baseTags).toContain("repo_conventions");
    expect(arg.tenant_id).toBe("t1");
    expect(arg.userPrompt).toContain("target development not main");
    expect(arg.userPrompt).toContain("no narration comments");
  });

  it("drops BOT-authored review comments from the distill input", async () => {
    mockGithub(
      "diff --git a/x.ts b/x.ts\n+x",
      [{ body: "human says: add a test", user: { type: "User" } }],
      [{ body: "bot: coverage 80%", user: { type: "Bot" } }],
    );
    await distillRepoConventionsFromMergedPr({
      tenant_id: "t1",
      repo_full_name: "o/r",
      pull_number: 9,
      pr_url: "https://github.com/o/r/pull/9",
    });
    const arg = runDistill.mock.calls[0][0] as { userPrompt: string };
    expect(arg.userPrompt).toContain("human says: add a test");
    expect(arg.userPrompt).not.toContain("bot: coverage 80%");
  });

  it("a SCOPED-OUT repo (connected but not selected) → no GitHub read, no distill (E3)", async () => {
    getScopedRepoFullNames.mockResolvedValueOnce(["o/allowed"]);
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const res = await distillRepoConventionsFromMergedPr({
      tenant_id: "t1",
      repo_full_name: "o/r",
      pull_number: 9,
      pr_url: "https://github.com/o/r/pull/9",
    });
    expect(res).toEqual({ written: 0, skipped: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(runDistill).not.toHaveBeenCalled();
  });

  it("grandfather (scoped set == connected set) still distills (no regression)", async () => {
    getScopedRepoFullNames.mockResolvedValueOnce(["o/r", "o/other"]);
    mockGithub(
      "diff --git a/x.ts b/x.ts\n+const a = 1;",
      [{ body: "use development", user: { type: "User" } }],
      [],
    );
    const res = await distillRepoConventionsFromMergedPr({
      tenant_id: "t1",
      repo_full_name: "o/r",
      pull_number: 9,
      pr_url: "https://github.com/o/r/pull/9",
    });
    expect(res).toEqual({ written: 1, skipped: 0 });
    expect(runDistill).toHaveBeenCalledTimes(1);
  });

  it("a non-connected repo (guard throws) → no GitHub read, no distill", async () => {
    assertTenantConnectedRepo.mockRejectedValueOnce(new Error("CrossTenantRepoError"));
    const res = await distillRepoConventionsFromMergedPr({
      tenant_id: "t1",
      repo_full_name: "other/repo",
      pull_number: 1,
      pr_url: "https://github.com/other/repo/pull/1",
    });
    expect(res).toEqual({ written: 0, skipped: 0 });
    expect(runDistill).not.toHaveBeenCalled();
  });

  it("no token (GitHub not connected) → skip", async () => {
    getRepoInstallationToken.mockResolvedValueOnce(null);
    const res = await distillRepoConventionsFromMergedPr({
      tenant_id: "t1",
      repo_full_name: "o/r",
      pull_number: 9,
      pr_url: "https://github.com/o/r/pull/9",
    });
    expect(res).toEqual({ written: 0, skipped: 0 });
    expect(runDistill).not.toHaveBeenCalled();
  });

  it("empty diff AND no human review → skip the Opus call", async () => {
    mockGithub("", [], []);
    const res = await distillRepoConventionsFromMergedPr({
      tenant_id: "t1",
      repo_full_name: "o/r",
      pull_number: 9,
      pr_url: "https://github.com/o/r/pull/9",
    });
    expect(res).toEqual({ written: 0, skipped: 0 });
    expect(runDistill).not.toHaveBeenCalled();
  });

  it("honors the env kill switch", async () => {
    const prev = process.env.PRAXIS_REPO_CONVENTIONS_DISTILL_ENABLED;
    process.env.PRAXIS_REPO_CONVENTIONS_DISTILL_ENABLED = "0";
    try {
      const res = await distillRepoConventionsFromMergedPr({
        tenant_id: "t1",
        repo_full_name: "o/r",
        pull_number: 9,
        pr_url: "https://github.com/o/r/pull/9",
      });
      expect(res).toEqual({ written: 0, skipped: 0 });
      expect(assertTenantConnectedRepo).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined)
        delete process.env.PRAXIS_REPO_CONVENTIONS_DISTILL_ENABLED;
      else process.env.PRAXIS_REPO_CONVENTIONS_DISTILL_ENABLED = prev;
    }
  });
});

describe("readRepoConventions (run-start injection source)", () => {
  it("returns the per-repo convention notes (title + body)", async () => {
    conventionRows = [
      { title: "Branch target", body_markdown: "In this repo, target development." },
      { title: "Comments", body_markdown: "No narration comments in diffs." },
    ];
    const out = await readRepoConventions({ tenant_id: "t1", repo_full_name: "o/r" });
    expect(out).toEqual([
      { title: "Branch target", body: "In this repo, target development." },
      { title: "Comments", body: "No narration comments in diffs." },
    ]);
  });

  it("returns [] on a read error (best-effort)", async () => {
    memoryNoteError = { message: "boom" };
    const out = await readRepoConventions({ tenant_id: "t1", repo_full_name: "o/r" });
    expect(out).toEqual([]);
  });

  it("returns [] when repo_full_name is empty (no injection)", async () => {
    const out = await readRepoConventions({ tenant_id: "t1", repo_full_name: "" });
    expect(out).toEqual([]);
  });
});
