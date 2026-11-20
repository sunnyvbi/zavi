
import { describe, it, expect } from "vitest";
import {
  parseDeclaredToolMatchers,
  toolMatchesDeclared,
  makeLiveToolMatcher,
} from "../declared-tool-match";

describe("toolMatchesDeclared", () => {
  it("matches an exact concrete declaration", () => {
    const m = parseDeclaredToolMatchers(["github__get_repo"]);
    expect(toolMatchesDeclared("github__get_repo", m)).toBe(true);
    expect(toolMatchesDeclared("github__create_issue", m)).toBe(false);
  });

  it("matches a concrete tool covered by a per-server `server__*` wildcard", () => {
    const m = parseDeclaredToolMatchers(["composio__*"]);
    expect(toolMatchesDeclared("composio__search", m)).toBe(true);
    expect(toolMatchesDeclared("composio__anything_else", m)).toBe(true);
    expect(toolMatchesDeclared("slack__post_message", m)).toBe(false);
  });

  it("matches a concrete tool covered by a `prefix*__*` prefix wildcard", () => {
    const m = parseDeclaredToolMatchers(["pipedream_*__*"]);
    expect(toolMatchesDeclared("pipedream_gmail__send", m)).toBe(true);
    expect(toolMatchesDeclared("pipedream_slack__post", m)).toBe(true);
    expect(toolMatchesDeclared("composio__search", m)).toBe(false);
  });

  it("is FAIL-CLOSED: a concrete tool with no exact + no covering wildcard does not match", () => {
    const m = parseDeclaredToolMatchers(["github__get_repo", "composio__*"]);
    expect(toolMatchesDeclared("stripe__refund", m)).toBe(false);
  });

  it("an unparseable name matches only by exact equality", () => {
    const m = parseDeclaredToolMatchers(["weirdname", "composio__*"]);
    expect(toolMatchesDeclared("weirdname", m)).toBe(true);
    expect(toolMatchesDeclared("noseparator", m)).toBe(false);
  });

  it("makeLiveToolMatcher returns a predicate with the same semantics", () => {
    const live = makeLiveToolMatcher(["composio__*", "github__get_repo"]);
    expect(live("composio__search")).toBe(true);
    expect(live("github__get_repo")).toBe(true);
    expect(live("github__create_issue")).toBe(false);
    expect(live("stripe__refund")).toBe(false);
  });
});
