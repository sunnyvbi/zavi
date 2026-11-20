// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const net = vi.hoisted(() => ({ reply: { status: 200, body: {} as unknown } }));

vi.mock("@/lib/api", () => ({
  apiFetch: async () => ({
    ok: net.reply.status >= 200 && net.reply.status < 300,
    status: net.reply.status,
    json: async () => net.reply.body,
  }),
}));
vi.mock("./useBuildSessions", () => ({ notifyBuildSessionsChanged: () => {} }));

import {
  BUILD_CHANGE_HELD_MESSAGE,
  BUILD_REFINE_PENDING_EVENT,
  BUILD_REFINE_STARTED_EVENT,
  isHeldChange,
  refineRetryMessage,
  startBuildRefine,
} from "./useBuildSession";
import type { CreditRefusal } from "./creditRefusal";

const SESSION = "d130919a-bec1-48bc-9dbf-fba65217f05a";

function listen() {
  const started = vi.fn();
  const pending: Array<{ refine: unknown }> = [];
  const onPending = (e: Event) => pending.push((e as CustomEvent<{ refine: unknown }>).detail);
  window.addEventListener(BUILD_REFINE_STARTED_EVENT, started);
  window.addEventListener(BUILD_REFINE_PENDING_EVENT, onPending);
  return {
    started,
    pending,
    stop: () => {
      window.removeEventListener(BUILD_REFINE_STARTED_EVENT, started);
      window.removeEventListener(BUILD_REFINE_PENDING_EVENT, onPending);
    },
  };
}

afterEach(() => {
  net.reply = { status: 200, body: {} };
});

describe("startBuildRefine while the site is still building", () => {
  it("a held change comes back as held with the server's line, and never shows as a running change", async () => {
    net.reply = { status: 202, body: { ok: true, queued: true, chat: "Your site is still building. I'll make this change as soon as it finishes, instead of the one I was holding." } };
    const l = listen();
    const out = await startBuildRefine(SESSION, "Our prices start at $80", { optimistic: true });
    l.stop();
    expect(isHeldChange(out)).toBe(true);
    expect(out).toEqual({ kind: "held", message: "Your site is still building. I'll make this change as soon as it finishes, instead of the one I was holding." });
    expect(l.started).not.toHaveBeenCalled();
    expect(l.pending.at(-1)!.refine).toBeNull();
  });

  it("a held reply with no line still says it is held", async () => {
    net.reply = { status: 202, body: { ok: true, queued: true, chat: "  " } };
    expect(await startBuildRefine(SESSION, "Add our hours")).toEqual({ kind: "held", message: BUILD_CHANGE_HELD_MESSAGE });
  });

  it("a normal start is never mistaken for held", async () => {
    net.reply = { status: 200, body: { ok: true, conductor_run_id: "aaaaaaaa-0000-4000-8000-000000000001", chat: "x" } };
    const l = listen();
    const out = await startBuildRefine(SESSION, "Add our hours");
    l.stop();
    expect(out).toBeNull();
    expect(l.started).toHaveBeenCalledTimes(1);
  });

  it("a retry that comes back held shows the held line, never a blank refusal", async () => {
    net.reply = { status: 202, body: { ok: true, queued: true, chat: "Your site is still building." } };
    const out = await startBuildRefine(SESSION, "Add our hours", { retryOf: "r-1" });
    expect(isHeldChange(out)).toBe(true);
    expect(refineRetryMessage(out!)).toBe((out as { message: string }).message);
    expect(refineRetryMessage(out!)).not.toContain("undefined");
  });

  it("a retry refused for credits still shows the refusal's own words", () => {
    const refusal = { headline: "Out of credits.", detail: "Add credits to keep going." } as CreditRefusal;
    expect(refineRetryMessage(refusal)).toBe("Out of credits. Add credits to keep going.");
  });
});
