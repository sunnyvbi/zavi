
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const dispatchSrc = readFileSync(
  resolve(__dirname, "../dispatch-decision.ts"),
  "utf8",
);
const githubSrc = readFileSync(
  resolve(__dirname, "../../../src/services/mcp/internal/github.ts"),
  "utf8",
);

describe("github.open_pr result parsing contract", () => {
  it("the impl returns the PR link under `url`", () => {
    expect(githubSrc).toMatch(/url:\s*pr\.html_url/);
  });

  it("the dispatch handler reads `parsed.url` (html_url alone never matches)", () => {
    expect(dispatchSrc).toMatch(/pr_url\s*=\s*parsed\.url\s*\?\?/);
  });

  it("the dispatch handler does NOT rely solely on `parsed.html_url`", () => {
    expect(dispatchSrc).not.toMatch(/pr_url\s*=\s*parsed\.html_url\s*\?\?\s*""/);
  });
});
