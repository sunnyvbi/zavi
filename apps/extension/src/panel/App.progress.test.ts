
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./supabase", () => ({
  supabase: () => ({
    auth: {
      getSession: async () => ({ data: { session: { access_token: "test-token" } } }),
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

import { Panel, callsTo, installChrome, installFetch, newServer, type FakeServer } from "./test-harness";

let server: FakeServer;
let panel: Panel;

const STEP = (label: string) => ({ key: label, label, state: "done" as const });

beforeEach(() => {
  server = newServer();
  installFetch(server);
  installChrome();
  panel = new Panel(1);
});

afterEach(() => {
  panel.unmount();
  vi.restoreAllMocks();
});

describe("the wait describes this turn only", () => {
  it("shows the steps the run reports", async () => {
    server.progressReplies = [[STEP("Checked your company brain")]];
    await panel.mount();
    await panel.ask("what does this page say?");
    expect(
      server.calls.some((c) => c.path.endsWith("/progress")),
    ).toBe(true);
  });

  it("leaves nothing from the first turn visible after the second", async () => {
    server.progressReplies = [[STEP("Checked Slack"), STEP("Checked Stripe")]];
    await panel.mount();
    await panel.ask("first question");
    server.progressReplies = [[]];
    await panel.ask("second question");
    expect(panel.text).not.toContain("Checked Slack");
    expect(panel.text).not.toContain("Checked Stripe");
  });

  it("an empty answer leaves nothing stuck on screen", async () => {
    server.progressReplies = [[STEP("Checked Slack")], []];
    await panel.mount();
    await panel.ask("a question");
    expect(panel.text).not.toContain("Checked Slack");
  });

  it("works when the endpoint answers nothing at all", async () => {
    server.progressReplies = [[]];
    await panel.mount();
    await panel.ask("a question");
    expect(callsTo(server, "POST", "/api/agents/operator/chat")).toHaveLength(1);
    expect(panel.text).not.toContain("Zavi hit an error");
  });
});
