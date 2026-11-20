// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { buildPaneSources } from "./WebsiteTab";

const OLD_BUILTIN = "https://apna-tutor-693dfbdb.zaviagent.com";
const OLD_RENDER = "https://apna-tutor-693dfbdb.onrender.com";
const OLD_REPO = "https://github.com/Zavi-Latest-Build/apna-tutor-693dfbdb";

const base = {
  isBuild: true,
  marketingUrl: null,
  hosted: { builtinLiveUrl: OLD_BUILTIN, builtAppUrl: OLD_RENDER },
  buildPreviewUrl: null,
  appUrl: null,
  repoUrl: OLD_REPO,
  appRepoUrl: null,
};

describe("buildPaneSources", () => {
  it("a never-published site whose preview box stopped frames nothing, so the stopped screen with Restart shows (QA 8-5)", () => {
    const site = { id: "s1", status: "building", liveUrl: null, repoUrl: null };
    const dead = "https://5173-deadbox.e2b.app";
    expect(buildPaneSources({ ...base, site, appUrl: dead }).previewUrl).toBe(dead);
    expect(buildPaneSources({ ...base, site, appUrl: dead, previewStopped: true }).previewUrl).toBeNull();
    expect(
      buildPaneSources({ ...base, site: { ...site, liveUrl: "https://dog-1.zaviagent.com", status: "live" }, appUrl: dead, previewStopped: true })
        .previewUrl,
    ).toBe("https://dog-1.zaviagent.com");
  });

  it("a FAILED site session with nothing to show frames nothing, never the tenant's old site", () => {
    const out = buildPaneSources({
      ...base,
      site: { id: "s1", status: "failed", liveUrl: null, repoUrl: "https://github.com/Zavi-Latest-Build/dog-1" },
    });
    expect(out.previewUrl).toBeNull();
    expect(out.repoUrl).toBe("https://github.com/Zavi-Latest-Build/dog-1");
    expect(out.builtinLiveUrl).toBeNull();
    expect(out.builtAppUrl).toBeNull();
  });

  it("a site session frames its own live url, else its own preview", () => {
    const site = { id: "s1", status: "live", liveUrl: "https://dog-1.zaviagent.com", repoUrl: null };
    expect(buildPaneSources({ ...base, site, buildPreviewUrl: "https://5173-box.e2b.app" }).previewUrl).toBe(
      "https://dog-1.zaviagent.com",
    );
    expect(
      buildPaneSources({ ...base, site: { ...site, liveUrl: null, status: "building" }, buildPreviewUrl: "https://5173-box.e2b.app" })
        .previewUrl,
    ).toBe("https://5173-box.e2b.app");
    expect(buildPaneSources({ ...base, site, appRepoUrl: "https://github.com/x/own" }).repoUrl).toBe("https://github.com/x/own");
  });

  it("a live site with changes waiting for Publish frames the preview that holds them, never the live address", () => {
    const unpublished = {
      count: 1,
      changes: [{ id: "e1", kind: "edit" as const, at: "2026-10-02T12:00:00Z", message: "Add a badge" }],
      publish: { status: "none" as const, startedAt: null, url: null, retryable: false },
    };
    const site = { id: "s1", status: "live", liveUrl: "https://dog-1.zaviagent.com", repoUrl: null, unpublished };
    expect(buildPaneSources({ ...base, site, buildPreviewUrl: "https://5173-box.e2b.app" }).previewUrl).toBe(
      "https://5173-box.e2b.app",
    );
    expect(buildPaneSources({ ...base, site }).previewUrl).toBe("https://dog-1.zaviagent.com");
  });

  it("an old-flow build session and the Website tab are unchanged", () => {
    expect(buildPaneSources({ ...base, site: null, buildPreviewUrl: "https://5173-box.e2b.app" })).toEqual({
      previewUrl: OLD_BUILTIN,
      repoUrl: OLD_REPO,
      builtinLiveUrl: OLD_BUILTIN,
      builtAppUrl: OLD_RENDER,
    });
    const web = buildPaneSources({ ...base, isBuild: false, marketingUrl: "https://acme.com", site: null });
    expect(web.previewUrl).toBe("https://acme.com");
    const webSite = buildPaneSources({ ...base, isBuild: false, site: { id: "s", status: "failed", liveUrl: null, repoUrl: null } });
    expect(webSite.previewUrl).toBe(OLD_BUILTIN);
  });

  it("a Build session whose first status read has not landed frames nothing yet (no flash of the tenant's old site)", () => {
    const out = buildPaneSources({ ...base, site: null, pending: true, buildPreviewUrl: null });
    expect(out.previewUrl).toBeNull();
    expect(out.builtinLiveUrl).toBeNull();
    expect(out.builtAppUrl).toBeNull();
    expect(out.repoUrl).toBeNull();
    expect(buildPaneSources({ ...base, isBuild: false, site: null, pending: true }).previewUrl).toBe(OLD_BUILTIN);
  });
});
