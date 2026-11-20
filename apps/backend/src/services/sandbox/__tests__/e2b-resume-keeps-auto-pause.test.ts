import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  order: [] as string[],
  posts: [] as Array<{ path: string; init: { params: { path: { sandboxID: string } }; body: { autoPause: boolean; timeout: number } } }>,
  postImpl: null as null | (() => Promise<{ response: { status: number } }>),
}));

vi.mock("e2b", () => {
  class ConnectionConfig {
    constructor(public opts: unknown) {}
    getSignal(): AbortSignal | undefined {
      return undefined;
    }
  }
  class ApiClient {
    api = {
      POST: async (path: string, init: (typeof h.posts)[number]["init"]) => {
        h.order.push(`resume:${init.params.path.sandboxID}`);
        h.posts.push({ path, init });
        return h.postImpl ? h.postImpl() : { response: { status: 201 } };
      },
    };
    constructor(public config: unknown) {}
  }
  const Sandbox = {
    connect: vi.fn(async (id: string) => {
      h.order.push(`connect:${id}`);
      return {
        sandboxId: id,
        commands: { run: vi.fn(async () => ({ stdout: "ok", stderr: "", exitCode: 0 })) },
        setTimeout: vi.fn(async () => undefined),
      };
    }),
  };
  return { ApiClient, ConnectionConfig, Sandbox };
});

import { execCommand, resumeSandbox } from "@/services/sandbox/e2b-client";

beforeEach(() => {
  process.env.E2B_API_KEY = "test-key";
  h.order.length = 0;
  h.posts.length = 0;
  h.postImpl = null;
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("connecting to a sandbox resumes it with auto-pause kept", () => {
  it("resumes with autoPause on before e2b's own connect, so a timed-out session is saved, not dropped", async () => {
    await execCommand("sb-1", "echo hi", 5_000);
    expect(h.order).toEqual(["resume:sb-1", "connect:sb-1"]);
    expect(h.posts[0].path).toBe("/sandboxes/{sandboxID}/resume");
    expect(h.posts[0].init.body).toEqual({ autoPause: true, timeout: 300 });
  });

  it("the run-start resume keeps it too", async () => {
    await resumeSandbox("sb-2");
    expect(h.order).toEqual(["resume:sb-2", "connect:sb-2"]);
    expect(h.posts[0].init.body.autoPause).toBe(true);
  });

  for (const [label, impl] of [
    ["the box is already running (409)", async () => ({ response: { status: 409 } })],
    ["e2b answers an error", async () => ({ response: { status: 500 } })],
    ["the call throws", async () => Promise.reject(new Error("network down"))],
  ] as const) {
    it(`still connects when ${label}`, async () => {
      h.postImpl = impl as () => Promise<{ response: { status: number } }>;
      const r = await execCommand("sb-3", "echo hi", 5_000);
      expect(r.exit_code).toBe(0);
      expect(h.order).toEqual(["resume:sb-3", "connect:sb-3"]);
    });
  }
});
