import { describe, it, expect } from "vitest";
import {
  resolveTrackerOrigin,
  scanTrackerCandidates,
} from "../tracker-origin";

const BOTH = { jira: true, linear: true };
const JIRA_ONLY = { jira: true, linear: false };
const LINEAR_ONLY = { jira: false, linear: true };
const NONE = { jira: false, linear: false };

describe("scanTrackerCandidates", () => {
  it("classifies an atlassian browse URL as a Jira URL key", () => {
    const r = scanTrackerCandidates(
      "implement https://upcar.atlassian.net/browse/SCRUM-4789 please",
    );
    expect(r.jiraUrlKeys).toEqual(["SCRUM-4789"]);
    expect(r.linearUrlKeys).toEqual([]);
    expect(r.bareKeys).toEqual([]);
  });

  it("classifies a linear.app URL as a Linear URL key", () => {
    const r = scanTrackerCandidates(
      "fix https://linear.app/upcar/issue/ENG-1234/some-slug",
    );
    expect(r.linearUrlKeys).toEqual(["ENG-1234"]);
    expect(r.jiraUrlKeys).toEqual([]);
    expect(r.bareKeys).toEqual([]);
  });

  it("treats a standalone key as a bare (connector-ambiguous) key", () => {
    const r = scanTrackerCandidates("please implement SCRUM-4789 today");
    expect(r.bareKeys).toEqual(["SCRUM-4789"]);
    expect(r.jiraUrlKeys).toEqual([]);
    expect(r.linearUrlKeys).toEqual([]);
  });

  it("does not match version-ish or non-key tokens", () => {
    const r = scanTrackerCandidates(
      "bump to v2 over utf-8 with claude-4 and node-18, no tickets here",
    );
    expect(r.bareKeys).toEqual([]);
    expect(r.jiraUrlKeys).toEqual([]);
    expect(r.linearUrlKeys).toEqual([]);
  });

  it("matches only UPPERCASE keys (Jira/Linear render keys uppercase)", () => {
    const r = scanTrackerCandidates("scrum-12 is lowercase but SCRUM-12 is real");
    expect(r.bareKeys).toEqual(["SCRUM-12"]);
  });
});

describe("resolveTrackerOrigin", () => {
  it("resolves a Jira browse URL to jira when jira is enabled", () => {
    expect(
      resolveTrackerOrigin(
        "do https://x.atlassian.net/browse/SCRUM-4789",
        BOTH,
      ),
    ).toEqual({ connector: "jira", key: "SCRUM-4789" });
  });

  it("resolves a Linear URL to linear when linear is enabled", () => {
    expect(
      resolveTrackerOrigin("do https://linear.app/o/issue/ENG-7", BOTH),
    ).toEqual({ connector: "linear", key: "ENG-7" });
  });

  it("URL hit wins over a bare key in the same text", () => {
    expect(
      resolveTrackerOrigin(
        "relates to ABC-1 but really https://x.atlassian.net/browse/SCRUM-9",
        BOTH,
      ),
    ).toEqual({ connector: "jira", key: "SCRUM-9" });
  });

  it("resolves a bare key to the SOLE enabled tracker (jira-only)", () => {
    expect(resolveTrackerOrigin("ship SCRUM-100", JIRA_ONLY)).toEqual({
      connector: "jira",
      key: "SCRUM-100",
    });
  });

  it("resolves a bare key to the SOLE enabled tracker (linear-only)", () => {
    expect(resolveTrackerOrigin("ship ENG-55", LINEAR_ONLY)).toEqual({
      connector: "linear",
      key: "ENG-55",
    });
  });

  it("REFUSES a bare key when BOTH trackers are enabled (ambiguous)", () => {
    expect(resolveTrackerOrigin("ship SCRUM-100", BOTH)).toBeNull();
  });

  it("returns null when no tracker is enabled even with a URL", () => {
    expect(
      resolveTrackerOrigin("https://x.atlassian.net/browse/SCRUM-9", NONE),
    ).toBeNull();
  });

  it("ignores a Jira URL when jira is disabled (linear-only tenant)", () => {
    expect(
      resolveTrackerOrigin(
        "https://x.atlassian.net/browse/SCRUM-9",
        LINEAR_ONLY,
      ),
    ).toBeNull();
  });

  it("returns null when there's no ticket reference at all", () => {
    expect(resolveTrackerOrigin("just a normal task, fix the bug", BOTH)).toBeNull();
  });
});
