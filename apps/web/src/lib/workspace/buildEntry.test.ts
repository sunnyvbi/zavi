import { describe, expect, it } from "vitest";
import { buildThreadOnOpen, pickBuildEntry } from "./buildEntry";

describe("pickBuildEntry", () => {
  it("keeps a session the Build tab is already bound to", () => {
    expect(pickBuildEntry("bound", "current", true)).toBe("bound");
  });
  it("opens the workspace's current build when nothing is bound", () => {
    expect(pickBuildEntry(null, "current", true)).toBe("current");
  });
  it("lands on Let's start with no build, or before the list loads", () => {
    expect(pickBuildEntry(null, null, true)).toBeNull();
    expect(pickBuildEntry(null, "current", false)).toBeNull();
  });
});

describe("buildThreadOnOpen", () => {
  const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const THREAD = "11111111-1111-4111-8111-111111111111";

  it("blanks the chat when one build gives way to another", () => {
    expect(buildThreadOnOpen(A, B, THREAD)).toBe(null);
    expect(buildThreadOnOpen(A, B, null)).toBe(null);
    expect(buildThreadOnOpen(A, B, undefined)).toBe(null);
    expect(buildThreadOnOpen(A, null, THREAD)).toBe(null);
  });

  it("keeps the thread a build is already bound to", () => {
    expect(buildThreadOnOpen(A, A, THREAD)).toBe(THREAD);
    expect(buildThreadOnOpen(A, A, null)).toBe(null);
    expect(buildThreadOnOpen(A, A, undefined)).toBe(null);
  });

  it("starts blank on a first open, when no build tab exists yet", () => {
    expect(buildThreadOnOpen(undefined, A, undefined)).toBe(null);
    expect(buildThreadOnOpen(undefined, null, undefined)).toBe(null);
  });

  it("blanks the chat when an unstarted build becomes a real one", () => {
    expect(buildThreadOnOpen(null, A, undefined)).toBe(null);
    expect(buildThreadOnOpen(null, A, THREAD)).toBe(null);
  });

  it("never answers undefined", () => {
    for (const prev of [A, null, undefined]) {
      for (const next of [A === prev ? B : A, null]) {
        expect(buildThreadOnOpen(prev, next, THREAD)).not.toBe(undefined);
      }
    }
  });
});
