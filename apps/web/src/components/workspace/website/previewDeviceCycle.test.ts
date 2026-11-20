
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { DEVICE_ORDER, nextDevice } from "./WebsitePreview";

const source = readFileSync(join(__dirname, "WebsitePreview.tsx"), "utf8");

describe("nextDevice", () => {
  it("runs widest to narrowest, then wraps", () => {
    expect(DEVICE_ORDER).toEqual(["desktop", "tablet", "mobile"]);
    expect(nextDevice("desktop")).toBe("tablet");
    expect(nextDevice("tablet")).toBe("mobile");
    expect(nextDevice("mobile")).toBe("desktop");
  });

  it("returns to the start after exactly one lap, visiting each width once", () => {
    const seen: string[] = [];
    let at: (typeof DEVICE_ORDER)[number] = "desktop";
    for (let i = 0; i < DEVICE_ORDER.length; i++) {
      seen.push(at);
      at = nextDevice(at);
    }
    expect(at).toBe("desktop");
    expect(new Set(seen).size).toBe(DEVICE_ORDER.length);
  });
});

describe("the chrome the cycle replaced", () => {
  it("keeps no device dropdown, chevron affordance or menu state", () => {
    expect(source).not.toContain("deviceMenuOpen");
    expect(source).not.toContain("deviceRef");
    expect(source).not.toContain('role="menuitemradio"');
  });

  it("names the width you are in and where the next click goes", () => {
    const at = source.indexOf("aria-label={`Preview width:");
    expect(at).toBeGreaterThan(-1);
    expect(source.slice(at, at + 160)).toContain("nextDevice(device)");
  });

  it("carries no full-screen control or its state", () => {
    expect(source).not.toContain("setFullscreen");
    expect(source).not.toContain("Maximize");
  });

  it("opens the app in a new page safely", () => {
    const at = source.indexOf('aria-label="Open in a new page"');
    expect(at).toBeGreaterThan(-1);
    const anchor = source.slice(source.lastIndexOf("<a", at), at + 60);
    expect(anchor).toContain('target="_blank"');
    expect(anchor).toContain('rel="noopener noreferrer"');
  });
});
