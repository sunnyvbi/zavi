// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));

import { usePastWorkImport } from "./usePastWorkImport";

const noop = async () => null;
const stored = (key: string) => JSON.parse(sessionStorage.getItem(key) ?? "null") as { text?: string } | null;
const hook = (initial: string | undefined) =>
  renderHook(({ k }: { k: string | undefined }) => usePastWorkImport(null, noop, noop, undefined, k), {
    initialProps: { k: initial },
  });

beforeEach(() => sessionStorage.clear());

describe("usePastWorkImport draft recovery keys", () => {
  it("carries a draft typed before any key into the first key", () => {
    const h = hook(undefined);
    act(() => h.result.current.setText("typed early"));
    h.rerender({ k: "user-a:site-a" });
    expect(stored("user-a:site-a")?.text).toBe("typed early");
    expect(h.result.current.text).toBe("typed early");
  });

  it("starts clean when the key changes to another site or user, without saving the old draft there", () => {
    const h = hook("user-a:site-a");
    act(() => h.result.current.setText("site A notes"));
    h.rerender({ k: "user-a:site-b" });
    expect(h.result.current.text).toBe("");
    expect(stored("user-a:site-b")).toBeNull();
    expect(stored("user-a:site-a")?.text).toBe("site A notes");
    h.rerender({ k: "user-b:site-b" });
    expect(stored("user-b:site-b")).toBeNull();
  });

  it("restores the right draft when coming back to a key", () => {
    sessionStorage.setItem("user-a:site-b", JSON.stringify({ text: "B notes", fileNames: [], savedAt: Date.now() }));
    const h = hook("user-a:site-a");
    act(() => h.result.current.setText("A notes"));
    h.rerender({ k: "user-a:site-b" });
    expect(h.result.current.text).toBe("B notes");
  });

  it("drops the old key at once on a switch, so text typed before the new key lands goes to the new key", () => {
    const h = hook("user-a:site-a");
    act(() => h.result.current.setText("A notes"));
    h.rerender({ k: undefined });
    expect(h.result.current.text).toBe("");
    act(() => h.result.current.setText("typed for B"));
    expect(stored("user-a:site-a")?.text).toBe("A notes");
    h.rerender({ k: "user-a:site-b" });
    expect(stored("user-a:site-b")?.text).toBe("typed for B");
  });
});
