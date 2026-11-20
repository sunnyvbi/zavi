// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { readWebsiteParam, rememberWebsiteView, WEBSITE_MODE_KEY } from "./websiteUrlParams";

afterEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "/workspace?tab=build&build=abc");
});

describe("rememberWebsiteView", () => {
  it("survives the tab switch that rebuilds the URL, via the same key WebsiteTab reads on mount", () => {
    window.history.replaceState(null, "", "/workspace?tab=build&build=abc");
    rememberWebsiteView("dashboard");
    expect(readWebsiteParam("view")).toBe("dashboard");
    window.history.replaceState(null, "", "/workspace?tab=website");
    expect(readWebsiteParam("view")).toBeNull();
    expect(window.localStorage.getItem(WEBSITE_MODE_KEY)).toBe("dashboard");
  });

  it("still sets the URL when storage is unavailable", () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    try {
      expect(() => rememberWebsiteView("preview")).not.toThrow();
      expect(readWebsiteParam("view")).toBe("preview");
    } finally {
      Storage.prototype.setItem = original;
    }
  });
});
