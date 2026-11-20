// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { clearWebsiteActivationIntent, hasWebsiteActivationIntent, saveWebsiteActivationIntent } from "./websiteWorkspaceStorage";

describe("website activation intent key", () => {
  beforeEach(() => localStorage.clear());

  it("every attempt of one intent gets the same key until it succeeds", () => {
    const first = saveWebsiteActivationIntent("u1", "bloom.com", true);
    expect(first).toMatch(/^[A-Za-z0-9_.:-]{8,200}$/);
    expect(saveWebsiteActivationIntent("u1", "bloom.com", true)).toBe(first);
    expect(hasWebsiteActivationIntent("u1", "bloom.com", true)).toBe(true);
    clearWebsiteActivationIntent("u1", "bloom.com", true);
    expect(saveWebsiteActivationIntent("u1", "bloom.com", true)).not.toBe(first);
  });

  it("another website or mode is another intent, with its own key", () => {
    const add = saveWebsiteActivationIntent("u1", "bloom.com", true);
    expect(saveWebsiteActivationIntent("u1", "bloom.com", false)).not.toBe(add);
    expect(saveWebsiteActivationIntent("u1", "other.com", true)).not.toBe(add);
  });
});
