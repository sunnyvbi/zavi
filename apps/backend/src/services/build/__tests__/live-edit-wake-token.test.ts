import { describe, it, expect, vi } from "vitest";

const calls = vi.hoisted(() => [] as string[]);

vi.mock("@/services/sandbox/e2b-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/sandbox/e2b-client")>()),
  wipeEnv: vi.fn(async (id: string) => {
    calls.push(`wipeEnv:${id}`);
  }),
  revokeSandboxGithubToken: vi.fn(async (id: string) => {
    calls.push(`revoke:${id}`);
  }),
}));

import { realWakeDeps } from "@/services/build/live-edit";

describe("waking the live edit preview", () => {
  it("strips the GitHub token from the git remote as well as the env file before tenant code is served", async () => {
    await realWakeDeps.wipe("sbx_1");
    expect(calls).toEqual(["revoke:sbx_1"]);
  });
});
