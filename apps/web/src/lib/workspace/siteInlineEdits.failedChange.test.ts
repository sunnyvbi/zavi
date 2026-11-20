// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { BUILD_EDITS_SAVING_EVENT, type SavingEditsEntry } from "./useBuildSession";
import { startSavingChange } from "./siteInlineEdits";

type Detail = { sessionId: string; clientId: string; entry: SavingEditsEntry | null };

function listen() {
  const seen = new Map<string, SavingEditsEntry>();
  const on = (e: Event) => {
    const d = (e as CustomEvent<Detail>).detail;
    if (d.entry) seen.set(`${d.sessionId}|${d.clientId}`, d.entry);
    else seen.delete(`${d.sessionId}|${d.clientId}`);
  };
  window.addEventListener(BUILD_EDITS_SAVING_EVENT, on);
  return { seen, stop: () => window.removeEventListener(BUILD_EDITS_SAVING_EVENT, on) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("failed site changes in the chat", () => {
  it("a failed change is cleared by the next try in the same chat, so failures never pile up", () => {
    const chat = listen();
    startSavingChange("s1", "Changed the theme")({ error: "Couldn't save" });
    startSavingChange("s1", "Changed the theme")({ error: "Couldn't save" });
    expect([...chat.seen.values()].filter((e) => e.failed)).toHaveLength(1);
    const settle = startSavingChange("s1", "Changed the theme");
    expect([...chat.seen.values()].filter((e) => e.failed)).toHaveLength(0);
    settle("change-1");
    expect([...chat.seen.values()].map((e) => e.settledId)).toEqual(["change-1"]);
    chat.stop();
  });

  it("a failure in one chat is left alone when another chat starts a change", () => {
    const chat = listen();
    startSavingChange("s1", "Changed the theme")({ error: "Couldn't save" });
    startSavingChange("s2", "Applied 1 edit");
    const failed = [...chat.seen.entries()].filter(([, e]) => e.failed).map(([k]) => k.split("|")[0]);
    expect(failed).toEqual(["s1"]);
    chat.stop();
  });
});
