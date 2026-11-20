import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/sandbox/e2b-client", () => ({ execCommand: vi.fn() }));

import { buildPrFilesFromSandboxFs, isForbiddenPath, BuilderRejectedError } from "../from-sandbox-fs";
import { execCommand } from "@/services/sandbox/e2b-client";

const execMock = vi.mocked(execCommand);
beforeEach(() => {
  execMock.mockReset();
});

const ok = (stdout: string) => ({ stdout, stderr: "", exit_code: 0, ms: 0 });

function sandboxWith(paths: string[], records?: string[]) {
  execMock.mockImplementation(async (...args: unknown[]) => {
    const cmd = String(args[1] ?? "");
    if (cmd.includes("git status")) return ok((records ?? paths.map((p) => `?? ${p}`)).join("\0") + "\0");
    if (cmd.includes("cat ")) return ok("create table if not exists public.x (id int);\n");
    return ok("");
  });
}

describe("site repos: supabase/migrations is the schema contract (fast website builds)", () => {
  it("stays forbidden everywhere by default", () => {
    expect(isForbiddenPath("supabase/migrations/001_bookings.sql")).toBe(true);
  });

  it("is allowed only as a top-level migration file of a verified site repo", () => {
    const site = { siteRepo: true };
    expect(isForbiddenPath("supabase/migrations/001_bookings.sql", site)).toBe(false);
    expect(isForbiddenPath("supabase/migrations/notes.md", site)).toBe(true);
    expect(isForbiddenPath("supabase/migrations/nested/001.sql", site)).toBe(true);
    expect(isForbiddenPath("supabase/migrations/", site)).toBe(true);
    expect(isForbiddenPath(".env", site)).toBe(true);
    expect(isForbiddenPath(".env.local", site)).toBe(true);
    expect(isForbiddenPath(".github/workflows/deploy.yml", site)).toBe(true);
    expect(isForbiddenPath("supabase/migrations/.env", site)).toBe(true);
    expect(isForbiddenPath("supabase/migrations/key.pem", site)).toBe(true);
  });

  it("the builder rejects a site migration without the site flag (today's behaviour)", async () => {
    sandboxWith(["supabase/migrations/001_grooming_bookings.sql"]);
    await expect(buildPrFilesFromSandboxFs({ sandbox_id: "sbx" })).rejects.toMatchObject({
      detail: { kind: "forbidden_path", path: "supabase/migrations/001_grooming_bookings.sql" },
    });
  });

  it("the builder ships a site migration when the run is a verified site repo", async () => {
    sandboxWith(["supabase/migrations/001_grooming_bookings.sql", "src/pages/Book.tsx"]);
    const r = await buildPrFilesFromSandboxFs({ sandbox_id: "sbx", site_repo: true });
    expect(r.files.map((f) => f.path).sort()).toEqual(["src/pages/Book.tsx", "supabase/migrations/001_grooming_bookings.sql"]);
  });

  it("a site repo still refuses a workflow file", async () => {
    sandboxWith(["supabase/migrations/001_a.sql", ".github/workflows/x.yml"]);
    const err = await buildPrFilesFromSandboxFs({ sandbox_id: "sbx", site_repo: true }).catch((e) => e);
    expect(err).toBeInstanceOf(BuilderRejectedError);
    expect((err as BuilderRejectedError).detail).toEqual({
      kind: "forbidden_path",
      path: ".github/workflows/x.yml",
      paths: [".github/workflows/x.yml"],
    });
  });

  it("a refusal names EVERY forbidden path, not just the first (one fix clears it)", async () => {
    sandboxWith(["src/App.tsx", "supabase/migrations/001_a.sql", ".env", ".github/workflows/x.yml"]);
    const err = await buildPrFilesFromSandboxFs({ sandbox_id: "sbx" }).catch((e) => e);
    expect(err).toBeInstanceOf(BuilderRejectedError);
    expect((err as BuilderRejectedError).detail).toEqual({
      kind: "forbidden_path",
      path: "supabase/migrations/001_a.sql",
      paths: ["supabase/migrations/001_a.sql", ".env", ".github/workflows/x.yml"],
    });
  });

  it("the reported paths are capped and de-duplicated", async () => {
    const many = Array.from({ length: 500 }, (_, i) => `.github/workflows/w${i}.yml`);
    sandboxWith([...many, many[0]]);
    const err = await buildPrFilesFromSandboxFs({ sandbox_id: "sbx" }).catch((e) => e);
    const d = (err as BuilderRejectedError).detail as { path: string; paths: string[] };
    expect(d.path).toBe(many[0]);
    expect(d.paths).toEqual(many.slice(0, 20));
  });
});

describe("site migrations: delete and rename are refused", () => {
  it("refuses deleting a migration", async () => {
    sandboxWith([], [" D supabase/migrations/001_a.sql"]);
    await expect(buildPrFilesFromSandboxFs({ sandbox_id: "sbx", site_repo: true })).rejects.toMatchObject({
      detail: { kind: "forbidden_path", path: "supabase/migrations/001_a.sql" },
    });
  });

  it("refuses renaming a migration", async () => {
    sandboxWith([], ["R  supabase/migrations/002_b.sql", "supabase/migrations/001_a.sql"]);
    await expect(buildPrFilesFromSandboxFs({ sandbox_id: "sbx", site_repo: true })).rejects.toMatchObject({
      detail: { kind: "forbidden_path" },
    });
  });
});
