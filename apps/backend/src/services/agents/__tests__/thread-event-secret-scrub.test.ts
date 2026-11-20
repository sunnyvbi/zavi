
import { describe, it, expect } from "vitest";
import { scrubSecretsFromText } from "@/services/mcp/egress-secret-scrub";

describe("thread_event / tool_calls secret scrub", () => {
  it("redacts an API key / PAT / JWT echoed into tool output", () => {
    const ghPat = "ghp_" + "a".repeat(36);
    const r = scrubSecretsFromText(`pushed with token ${ghPat} ok`);
    expect(r.scrubbed).not.toContain(ghPat);
    expect(r.scrubbed).toContain("[redacted]");
    expect(r.redactions).toContain("github_token");

    expect(scrubSecretsFromText("key=sk_live_" + "Z".repeat(20)).scrubbed).toContain(
      "[redacted]",
    );
  });

  it("does NOT over-redact numeric IDs / timestamps / emails in a code diff", () => {
    const diff =
      '+ const ts = 1719590400123;\n+ const id = "73db45ff-457e-4541";\n+ author: "dev@example.com"';
    const r = scrubSecretsFromText(diff);
    expect(r.scrubbed).toBe(diff);
    expect(r.redactions).toHaveLength(0);
  });
});
