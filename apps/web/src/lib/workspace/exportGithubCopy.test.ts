import { describe, expect, it } from "vitest";
import {
  exportErrorCopy,
  GITHUB_CONNECTOR_HREF,
  githubNewRepoUrl,
  repoNameFromUrl,
} from "./exportGithubCopy";

describe("exportErrorCopy", () => {
  it("sends github_not_connected to the Connectors GitHub card, not Settings → Company", () => {
    expect(exportErrorCopy("github_not_connected", "x")).toEqual({ kind: "connect" });
    expect(GITHUB_CONNECTOR_HREF).toBe("/workspace?tab=brain#connector-github");
  });

  it("reads the repo and owner out of the personal-account refusal", () => {
    const msg =
      'cannot auto-create "rahu/growth-agent-27927914" under a personal GitHub account. ' +
      'Create an empty repo named "growth-agent-27927914" under rahu on GitHub, then re-run the export.';
    expect(exportErrorCopy("dest_repo_must_exist", msg, "fallback")).toEqual({
      kind: "create_repo",
      repoName: "growth-agent-27927914",
      owner: "rahu",
      reason: "personal_account",
    });
  });

  it("turns the org create 403 (no Administration permission) into 'create it yourself'", () => {
    const msg =
      'export dest repo create failed (403): {"message":"Resource not accessible by integration"}';
    expect(exportErrorCopy("export_failed", msg, "app")).toMatchObject({
      kind: "create_repo",
      reason: "no_create_permission",
      repoName: "app",
    });
  });

  it("passes anything else through untouched", () => {
    expect(exportErrorCopy("export_failed", "boom")).toEqual({ kind: "raw", message: "boom" });
    expect(exportErrorCopy("network", "Failed to fetch")).toEqual({
      kind: "raw",
      message: "We couldn't reach Zavi. Check your connection and try again.",
    });
    const notEmpty = '"rahu/site" already has files Zavi did not put there (src). Export into a new or empty repo';
    expect(exportErrorCopy("dest_repo_not_empty", notEmpty, "site")).toEqual({
      kind: "raw",
      message: notEmpty,
    });
  });
});

describe("repoNameFromUrl", () => {
  it("returns the bare repo name the export uses as its default destination", () => {
    expect(repoNameFromUrl("https://github.com/Praxis-build/growth-agent-27927914")).toBe(
      "growth-agent-27927914",
    );
    expect(repoNameFromUrl("https://github.com/acme/app.git/")).toBe("app");
    expect(repoNameFromUrl(null)).toBeNull();
  });
});

describe("githubNewRepoUrl", () => {
  it("prefills GitHub's new-repo page with the exact name, owner and private visibility", () => {
    const url = new URL(githubNewRepoUrl("mohit-upcar", "mohit-93bd8436"));
    expect(`${url.origin}${url.pathname}`).toBe("https://github.com/new");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      name: "mohit-93bd8436",
      owner: "mohit-upcar",
      visibility: "private",
    });
  });

  it("escapes a name so it cannot smuggle extra query parameters", () => {
    const url = new URL(githubNewRepoUrl("acme", "a&visibility=public"));
    expect(url.searchParams.get("visibility")).toBe("private");
    expect(url.searchParams.get("name")).toBe("a&visibility=public");
  });

  it("gives every other known refusal a next step instead of the server's wording", () => {
    for (const code of ["no_provisioned_repo", "build_not_found", "not_zavi_managed", "dest_repo_changed_since_export", "export_not_configured", "forbidden"]) {
      const out = exportErrorCopy(code, `raw ${code} text`);
      expect(out.kind).toBe("raw");
      expect((out as { message: string }).message).not.toContain("raw ");
    }
  });
});
