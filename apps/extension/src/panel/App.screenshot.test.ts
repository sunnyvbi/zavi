
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

import { UNCAPTURABLE_NOTE } from "./App";
import { scaledSize } from "./screenshot";
import {
  Panel,
  callsTo,
  installChrome,
  installFetch,
  newServer,
  type FakeChrome,
  type FakeServer,
} from "./test-harness";

let server: FakeServer;
let chromeFake: FakeChrome;
let panel: Panel;

beforeEach(() => {
  server = newServer();
  installFetch(server);
  chromeFake = installChrome();
  panel = new Panel();
});

afterEach(() => {
  panel.unmount();
  vi.unstubAllGlobals();
});

describe("every Send captures and uploads a fresh screenshot", () => {
  it("two Sends in one thread: two captures, two uploads, two chat bodies with one image_path and screenshot page_context", async () => {
    await panel.mount();
    expect(chromeFake.captureVisibleTab).not.toHaveBeenCalled();

    await panel.ask("file a Jira for the task I gave Sam");
    server.uploadReply = { status: 200, json: { image_path: "tenant-1/second.jpg" } };
    await panel.ask("and assign it to me");

    expect(chromeFake.captureVisibleTab).toHaveBeenCalledTimes(2);
    expect(chromeFake.captureVisibleTab).toHaveBeenCalledWith(7, { format: "jpeg", quality: 70 });

    const uploads = callsTo(server, "POST", "/api/extension/screenshot");
    expect(uploads).toHaveLength(2);
    for (const u of uploads) {
      expect(u.body).toBeInstanceOf(FormData);
      const file = (u.body as FormData).get("file") as Blob;
      expect(file.type).toBe("image/jpeg");
    }

    const chats = callsTo(server, "POST", "/api/agents/operator/chat");
    expect(chats).toHaveLength(2);
    const [first, second] = chats.map((c) => c.body as Record<string, unknown>);
    expect(first.image_paths).toEqual(["tenant-1/shot.jpg"]);
    expect(second.image_paths).toEqual(["tenant-1/second.jpg"]);
    for (const b of [first, second]) {
      expect(b.page_context).toEqual({
        mode: "screenshot",
        url: "https://app.slack.com/client/T1/D1",
        title: "Slack | DM with Sam",
      });
    }
    expect(first.thread_id).toBeNull();
    expect(second.thread_id).toBe("thread-1");
    expect(panel.text).toContain("answer 2");
  });

  it("an uncapturable tab sends text only: no capture, no upload, no image_paths or page_context, and says so", async () => {
    chromeFake.tab.url = "chrome://settings/";
    chromeFake.tab.title = "Settings";
    await panel.mount();
    await panel.ask("what does this setting do?");

    expect(chromeFake.captureVisibleTab).not.toHaveBeenCalled();
    expect(callsTo(server, "POST", "/api/extension/screenshot")).toHaveLength(0);
    const chats = callsTo(server, "POST", "/api/agents/operator/chat");
    expect(chats).toHaveLength(1);
    const body = chats[0].body as Record<string, unknown>;
    expect(body).not.toHaveProperty("image_paths");
    expect(body).not.toHaveProperty("page_context");
    expect(body.message).toBe("what does this setting do?");
    expect(panel.text).toContain(UNCAPTURABLE_NOTE);
  });

  it("a capture error also falls back to text only", async () => {
    chromeFake.captureVisibleTab.mockRejectedValue(new Error("Tabs cannot be edited right now"));
    await panel.mount();
    await panel.ask("hello");

    expect(callsTo(server, "POST", "/api/extension/screenshot")).toHaveLength(0);
    const body = callsTo(server, "POST", "/api/agents/operator/chat")[0].body as Record<string, unknown>;
    expect(body).not.toHaveProperty("image_paths");
    expect(panel.text).toContain(UNCAPTURABLE_NOTE);
  });

  it("a permission refusal asks Chrome for <all_urls> once and retries the capture once", async () => {
    chromeFake.captureVisibleTab
      .mockRejectedValueOnce(
        new Error("Either the '<all_urls>' or 'activeTab' permission is required."),
      )
      .mockResolvedValueOnce("data:image/jpeg;base64,/9j/");
    await panel.mount();
    chromeFake.permissionsContains.mockResolvedValue(false);
    await panel.ask("what is on this page?");

    expect(chromeFake.permissionsRequest).toHaveBeenCalledTimes(1);
    expect(chromeFake.permissionsRequest).toHaveBeenCalledWith({ origins: ["<all_urls>"] });
    expect(chromeFake.captureVisibleTab).toHaveBeenCalledTimes(2);
    expect(callsTo(server, "POST", "/api/extension/screenshot")).toHaveLength(1);
  });

  it("says it is still working when the run continues past its first reply", async () => {
    server.runStatus = "running";
    await panel.mount();
    await panel.ask("have the engineer fix this");
    expect(panel.text).toContain("Still working");
  });
});

describe("downscale", () => {
  it("caps the long edge at 1568 and never scales up", () => {
    expect(scaledSize(3136, 1960)).toEqual({ width: 1568, height: 980 });
    expect(scaledSize(1000, 3136)).toEqual({ width: 500, height: 1568 });
    expect(scaledSize(1280, 800)).toEqual({ width: 1280, height: 800 });
  });
});
