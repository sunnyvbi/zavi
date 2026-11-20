
import { execFileSync } from "node:child_process";
import { describe, it, expect, vi, beforeEach } from "vitest";

const write = vi.fn();
vi.mock("e2b", () => ({
  Sandbox: { connect: vi.fn(async () => ({ files: { write } })) },
}));

import { setEnv, wipeEnv } from "../e2b-client";

beforeEach(() => {
  write.mockReset();
  process.env.E2B_API_KEY = "test-key";
});

describe("wipeEnv", () => {
  it("overwrites the env file with unset lines, never an empty export", async () => {
    await wipeEnv("sbx");
    const [path, content] = write.mock.calls[0] as [string, string];
    expect(path).toMatch(/praxis-env/);
    expect(content).not.toMatch(/export /);
    expect(content).not.toMatch(/VITE_[A-Z_]*=/);
    for (const k of ["GITHUB_TOKEN", "NODE_OPTIONS", "VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY"]) {
      expect(content).toContain(`unset ${k}\n`);
    }
  });

  it("setEnv writes an empty value as unset, a real one as an export", async () => {
    await setEnv("sbx", { VITE_SUPABASE_URL: "", GITHUB_TOKEN: "ghs_x" });
    const content = (write.mock.calls[0] as [string, string])[1];
    expect(content).toBe(`unset VITE_SUPABASE_URL\nexport GITHUB_TOKEN="ghs_x"\n`);
  });

  it("sourced the way execCommand sources it, it removes the names and does not trip set -e", async () => {
    await wipeEnv("sbx");
    const content = (write.mock.calls[0] as [string, string])[1];
    const script = `set -e; set -a; ${content.replace(/\n/g, "; ")} set +a; echo "url=[\${VITE_SUPABASE_URL-UNSET}] anon=[\${VITE_SUPABASE_ANON_KEY-UNSET}]"`;
    const out = execFileSync("sh", ["-c", script], {
      env: { PATH: process.env.PATH ?? "", VITE_SUPABASE_URL: "stale", VITE_SUPABASE_ANON_KEY: "" },
    }).toString();
    expect(out.trim()).toBe("url=[UNSET] anon=[UNSET]");
  });
});
