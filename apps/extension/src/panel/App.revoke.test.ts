
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

import { CONSENT_TITLE } from "./components/ConsentScreen";
import { turnedOffLine } from "./components/SettingsScreen";
import {
  Panel,
  callsTo,
  installChrome,
  installFetch,
  newServer,
  type FakeServer,
} from "./test-harness";

let server: FakeServer;
let panel: Panel;

beforeEach(() => {
  server = newServer();
  installFetch(server);
  installChrome();
  panel = new Panel();
});

afterEach(() => {
  panel.unmount();
  vi.unstubAllGlobals();
});

const deletes = () => callsTo(server, "DELETE", "/api/extension/consent");

async function openTurnOff(): Promise<void> {
  await panel.click('button[aria-label="Settings"]');
  await panel.click("button.zv-settings-danger");
}

describe("nothing is deleted until the person confirms", () => {
  it("the first press asks, and sends NOTHING to the server", async () => {
    await panel.mount();
    await openTurnOff();
    expect(deletes()).toHaveLength(0);
    expect(panel.text).toContain("Turn off page reading?");
  });

  it("the settings copy says turning it off deletes your screenshots", async () => {
    await panel.mount();
    await panel.click('button[aria-label="Settings"]');
    expect(panel.text).toContain("This deletes your screenshots");
  });

  it("backing out of the confirm step leaves everything as it was", async () => {
    await panel.mount();
    await openTurnOff();
    await panel.click("button.zv-settings-cancel");
    expect(deletes()).toHaveLength(0);
    expect(panel.text).toContain("Turn off page reading");
  });

  it("the second press is the one that does it, and it does it once", async () => {
    await panel.mount();
    await openTurnOff();
    await panel.click("button.zv-settings-confirm");
    expect(deletes()).toHaveLength(1);
  });
});

describe("the count reported is the server's, not a local guess", () => {
  it("reports the number the server cleared", async () => {
    server.runsCleared = 7;
    await panel.mount();
    await openTurnOff();
    await panel.click("button.zv-settings-confirm");
    expect(panel.text).toContain(turnedOffLine(7));
  });

  it("shows no number at all when the server did not give one", async () => {
    server.runsCleared = undefined;
    await panel.mount();
    await openTurnOff();
    await panel.click("button.zv-settings-confirm");
    expect(panel.text).toContain("Page reading is off.");
    expect(panel.text).not.toContain("erased the page content from");
  });
});

describe("a failed turn-off claims nothing", () => {
  it("says it did not happen, and does not say page reading is off", async () => {
    server.revokeFails = true;
    await panel.mount();
    await openTurnOff();
    await panel.click("button.zv-settings-confirm");
    expect(panel.text).not.toContain("Page reading is off.");
    expect(panel.text).toContain("Zavi couldn't finish turning page reading off. Some screenshots may not be deleted yet.");
  });
});

describe("after turning it off, the next Send is gated again", () => {
  it("no screenshot is uploaded, nothing is sent, and the operator is asked", async () => {
    await panel.mount();
    await panel.ask("what is this?");
    expect(callsTo(server, "POST", "/api/extension/screenshot")).toHaveLength(1);
    expect(callsTo(server, "POST", "/api/agents/operator/chat")).toHaveLength(1);

    await openTurnOff();
    await panel.click("button.zv-settings-confirm");
    await panel.click("button.zv-settings-back");
    await panel.ask("and now?");

    expect(callsTo(server, "POST", "/api/extension/screenshot")).toHaveLength(1);
    expect(callsTo(server, "POST", "/api/agents/operator/chat")).toHaveLength(1);
    expect(panel.text).toContain(CONSENT_TITLE);
  });

  it("saying yes again stops settings claiming it is off", async () => {
    await panel.mount();
    await openTurnOff();
    await panel.click("button.zv-settings-confirm");
    expect(panel.text).toContain("Page reading is off.");
    await panel.click("button.zv-settings-back");

    await panel.ask("and now?");
    await panel.click("button.zv-consent-accept");
    expect(server.consentGranted).toBe(true);

    await panel.click('button[aria-label="Settings"]');
    expect(panel.text).not.toContain("Page reading is off.");
    expect(panel.text).toContain("Turn off page reading");
  });
});

describe("what the screen says about the count", () => {
  it("never prints a bare zero", () => {
    expect(turnedOffLine(0)).toBe(
      "Page reading is off. There was no page content stored to erase.",
    );
  });

  it("counts one question in the singular", () => {
    expect(turnedOffLine(1)).toBe(
      "Page reading is off. Zavi erased the page content from 1 question.",
    );
    expect(turnedOffLine(4)).toBe(
      "Page reading is off. Zavi erased the page content from 4 questions.",
    );
  });

  it("stays quiet about the count when there is none", () => {
    expect(turnedOffLine(null)).toBe("Page reading is off.");
  });
});
