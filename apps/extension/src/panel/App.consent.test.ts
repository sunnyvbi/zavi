
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

import { DAILY_CAP_NOTE } from "./App";
import { CONSENT_TITLE } from "./components/ConsentScreen";
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

const consentPosts = () => callsTo(server, "POST", "/api/extension/consent");
const chats = () => callsTo(server, "POST", "/api/agents/operator/chat");
const uploads = () => callsTo(server, "POST", "/api/extension/screenshot");

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

describe("the first-run screen owns the permission moment", () => {
  it("is offered before the first question, not during it", async () => {
    server.consentGranted = false;
    await panel.mount();

    expect(panel.text).toContain(CONSENT_TITLE);
    expect(chromeFake.captureVisibleTab).not.toHaveBeenCalled();
    expect(uploads()).toHaveLength(0);
    expect(chats()).toHaveLength(0);
  });

  it("is offered when Chrome has no site access, even with consent on file", async () => {
    server.consentGranted = true;
    chromeFake.permissionsContains.mockResolvedValue(false);
    await panel.mount();

    expect(panel.text).toContain(CONSENT_TITLE);
  });

  it("stays out of the way once consent and site access are both in place", async () => {
    await panel.mount();
    expect(panel.text).not.toContain(CONSENT_TITLE);
    expect(panel.host.querySelector("textarea")).not.toBeNull();
  });

  it("accepting asks CHROME first and records consent only after it says yes", async () => {
    server.consentGranted = false;
    chromeFake.permissionsContains.mockResolvedValue(false);

    let consentPostsWhenChromeWasAsked = -1;
    chromeFake.permissionsRequest.mockImplementationOnce(async () => {
      consentPostsWhenChromeWasAsked = consentPosts().length;
      return true;
    });

    await panel.mount();
    await panel.click("button.zv-consent-accept");

    expect(chromeFake.permissionsRequest).toHaveBeenCalledWith({
      origins: ["<all_urls>"],
    });
    expect(consentPostsWhenChromeWasAsked).toBe(0);
    expect(consentPosts()).toHaveLength(1);
    expect(panel.text).not.toContain(CONSENT_TITLE);
  });

  it("a Chrome refusal records NO consent, offers the ask again, and sends nothing", async () => {
    server.consentGranted = false;
    chromeFake.permissionsContains.mockResolvedValue(false);
    chromeFake.permissionsRequest.mockResolvedValue(false);

    await panel.mount();
    await panel.click("button.zv-consent-decline");
    await panel.ask("draft a reply to this");
    expect(panel.text).toContain(CONSENT_TITLE);

    await panel.click("button.zv-consent-accept");

    expect(chromeFake.permissionsRequest).toHaveBeenCalled();
    expect(consentPosts()).toHaveLength(0);
    expect(uploads()).toHaveLength(0);
    expect(chats()).toHaveLength(0);
    expect(panel.text).toContain("Ask Chrome again");
    expect(panel.text).toContain("Chrome did not grant access");
    expect(panel.host.querySelector("button.zv-consent-decline")).not.toBeNull();
  });

  it("declining does not re-ask on the next panel for the same Chrome session", async () => {
    server.consentGranted = false;
    await panel.mount();
    await panel.click("button.zv-consent-decline");

    const again = new Panel();
    await again.mount();
    expect(again.text).not.toContain(CONSENT_TITLE);
    again.unmount();
  });
});

describe("no agreement means no screenshot leaves the browser", () => {
  it("consent absent: the panel asks, and neither uploads nor sends", async () => {
    server.consentGranted = false;
    await panel.mount();
    await panel.click("button.zv-consent-decline");
    await panel.ask("what is this?");

    expect(uploads()).toHaveLength(0);
    expect(chats()).toHaveLength(0);
    expect(panel.text).toContain(CONSENT_TITLE);
  });

  it("upload 403 consent_required: consent screen, chat NOT called", async () => {
    server.uploadReply = {
      status: 403,
      json: { error: { code: "consent_required", message: "consent required" } },
    };
    await panel.mount();
    await panel.ask("what is this?");

    expect(uploads()).toHaveLength(1);
    expect(chats()).toHaveLength(0);
    expect(panel.text).toContain(CONSENT_TITLE);
  });

  it("upload 429 extension_daily_cap: cap message, chat NOT called", async () => {
    server.uploadReply = {
      status: 429,
      json: { error: { code: "extension_daily_cap", message: "cap" } },
    };
    await panel.mount();
    await panel.ask("what is this?");

    expect(chats()).toHaveLength(0);
    expect(panel.text).toContain(DAILY_CAP_NOTE);
    expect(panel.text).not.toContain(CONSENT_TITLE);
  });

  it("accepting on the screen records consent, then sends the held message with a fresh screenshot", async () => {
    server.consentGranted = false;
    await panel.mount();
    await panel.click("button.zv-consent-decline");
    await panel.ask("which task did I give Sam?");
    await panel.click("button.zv-consent-accept");

    expect(consentPosts()).toHaveLength(1);
    expect(callsTo(server, "GET", "/api/extension/consent")).toHaveLength(2);
    expect(uploads()).toHaveLength(1);
    expect(chats()).toHaveLength(1);
    const body = chats()[0].body as Record<string, unknown>;
    expect(body.message).toBe("which task did I give Sam?");
    expect(body.image_paths).toEqual(["tenant-1/shot.jpg"]);
  });

  it("declining sends nothing and puts the message back in the composer", async () => {
    server.consentGranted = false;
    await panel.mount();
    await panel.click("button.zv-consent-decline");
    await panel.ask("which task did I give Sam?");
    await panel.click("button.zv-consent-decline");

    expect(chats()).toHaveLength(0);
    expect(panel.host.querySelector("textarea")?.value).toBe(
      "which task did I give Sam?",
    );
  });
});
