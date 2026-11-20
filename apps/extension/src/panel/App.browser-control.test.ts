
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./supabase", () => ({
  supabase: () => ({
    auth: {
      getSession: async () => ({
        data: { session: { access_token: "test-token", user: { id: "user-1" } } },
      }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => undefined } } }),
    },
  }),
}));
vi.mock("./auth", () => ({ signOut: vi.fn() }));
vi.mock("../shared/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../shared/config")>()),
  ANSWER_POLL_MS: 0,
  THREAD_IDLE_POLL_MS: 3_600_000,
}));

import {
  Panel,
  callsTo,
  fakeDebuggerApi,
  installChrome,
  installFetch,
  newServer,
  type FakeServer,
} from "./test-harness";

let server: FakeServer;
let panel: Panel;
let dbg: ReturnType<typeof fakeDebuggerApi>;

const scrollOp = (tab = 1) => ({
  id: "op-1",
  run_id: "run-1",
  seq: 1,
  tab_id: tab,
  op: { op: "scroll", dy: 300 },
  is_write: false,
  execution_token: "tok-1",
  lease_until: "2026-09-30T00:00:15Z",
});

beforeEach(() => {
  server = newServer();
  installFetch(server);
  dbg = fakeDebuggerApi();
  installChrome({ debuggerApi: dbg });
  panel = new Panel(1);
});

afterEach(() => {
  panel.unmount();
  vi.restoreAllMocks();
});

describe("browser control in the panel", () => {
  it("opens a session for its OWN tab and does not attach until an op arrives", async () => {
    await panel.mount();
    expect(callsTo(server, "POST", "/api/extension/sessions")[0]?.body).toEqual({ tab_id: 1 });
    expect(dbg.attach).not.toHaveBeenCalled();
    expect(panel.text).not.toContain("Zavi is working in this tab");
  });

  it("shows the working bar and a step line while it works, and Stop ends the session", async () => {
    server.extOps.push(scrollOp());
    await panel.mount();
    expect(dbg.attach).toHaveBeenCalledWith({ tabId: 1 }, "1.3");
    expect(panel.text).toContain("Zavi is working in this tab");
    expect(panel.text).toContain("Scrolled down");
    expect(callsTo(server, "POST", "/api/extension/ops/op-1/result")[0]?.body).toMatchObject({
      execution_token: "tok-1",
      status: "done",
    });

    await panel.click(".zv-workbar-stop");
    expect(callsTo(server, "DELETE", "/api/extension/sessions/sess-1")).toHaveLength(1);
    expect(dbg.detach).toHaveBeenCalledWith({ tabId: 1 });
    expect(panel.text).not.toContain("Zavi is working in this tab");
    expect(panel.text).toContain("Stopped. Here's what I did before you stopped me:");
  });

  it("sends its panel session with a chat turn so the run can work in this tab (S4)", async () => {
    await panel.mount();
    await panel.ask("raise the budget to $50");
    const body = callsTo(server, "POST", "/api/agents/operator/chat")[0]?.body as Record<string, unknown>;
    expect(body.panel_session_id).toBe("sess-1");
  });

  it("refuses an op for another tab without attaching", async () => {
    server.extOps.push(scrollOp(2));
    await panel.mount();
    expect(dbg.attach).not.toHaveBeenCalled();
    expect(callsTo(server, "POST", "/api/extension/ops/op-1/result")[0]?.body).toMatchObject({
      status: "failed",
      result: { error_code: "wrong_tab" },
    });
  });
});
