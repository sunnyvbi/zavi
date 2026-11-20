import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GITHUB_TOKEN_PATTERN, githubTokenRegex } from "../github-token-pattern";
import { scrubQueryForCapture } from "@/services/memory/eval-capture-scrub";
import { scanOutboundEmail } from "@/services/tools/email/outbound-scan";

const STATELESS = `ghs_123456_eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiIxMjM0NTYifQ.${"x-_Y".repeat(30)}`;

describe("GITHUB_TOKEN_PATTERN", () => {
  it.each([
    ["classic installation", "ghs_" + "A".repeat(36)],
    ["classic PAT", "ghp_" + "a".repeat(36)],
    ["OAuth", "gho_" + "1".repeat(36)],
    ["user-to-server", "ghu_" + "b".repeat(36)],
    ["refresh", "ghr_" + "c".repeat(76)],
    ["fine-grained PAT", "github_pat_" + "D".repeat(22) + "_" + "e".repeat(59)],
    ["stateless installation", STATELESS],
  ])("matches a whole %s token", (_label, token) => {
    const m = `Authorization: token ${token} trailing`.match(githubTokenRegex());
    expect(m?.[0]).toBe(token);
  });

  it("is not fooled by one prepended character", () => {
    expect(githubTokenRegex().test("x" + "ghs_" + "A".repeat(36))).toBe(true);
  });

  it("ignores short look-alikes and ordinary snake_case words", () => {
    expect(githubTokenRegex().test("ghs_short and ghp_tooShort123")).toBe(false);
    expect(githubTokenRegex().test("laughs_and_more_words_here_ok_with_a_long_tail_value")).toBe(false);
    expect(githubTokenRegex().test("the coughs_1234_in_a.row.today metric")).toBe(false);
  });

  it("the Python runtime scrubber carries the same pattern", () => {
    const py = readFileSync(join(__dirname, "../../../../../agent-runtime/zavi_runtime/scrub.py"), "utf8");
    expect(py).toContain(`re.compile(r"${GITHUB_TOKEN_PATTERN}")`);
  });
});

describe("scrubbers built on the shared pattern", () => {
  it("eval capture redacts a stateless token completely", () => {
    const out = scrubQueryForCapture(`use ${STATELESS} please`);
    expect(out).not.toContain("eyJ");
    expect(out).not.toContain("ghs_");
  });

  it("the outbound email scan blocks a stateless token", () => {
    expect(scanOutboundEmail(`token: ${STATELESS}`).blocked).toBe(true);
  });
});
