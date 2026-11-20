import { describe, it, expect } from "vitest";
import { mdToMrkdwn, mrkdwnActionLinksToMarkdown } from "../mrkdwn";

describe("mdToMrkdwn", () => {
  it("converts ** bold to single-star Slack bold", () => {
    expect(mdToMrkdwn("flagged as a gap **today** (June 4)")).toBe(
      "flagged as a gap *today* (June 4)",
    );
  });

  it("converts __ bold to single-star Slack bold", () => {
    expect(mdToMrkdwn("only __legal@upcar.ai__ on file")).toBe("only *legal@upcar.ai* on file");
  });

  it("handles the reported escalation-email reply verbatim", () => {
    const input =
      "The only support-adjacent email on file is **legal@upcar.ai**, which is specifically for dispute pre-arbitration notices per the ToS.";
    expect(mdToMrkdwn(input)).toBe(
      "The only support-adjacent email on file is *legal@upcar.ai*, which is specifically for dispute pre-arbitration notices per the ToS.",
    );
  });

  it("collapses bold-italic *** to single-star bold", () => {
    expect(mdToMrkdwn("this is ***very*** important")).toBe("this is *very* important");
  });

  it("converts markdown links to Slack link syntax", () => {
    expect(mdToMrkdwn("see [our docs](https://x.io/docs) now")).toBe(
      "see <https://x.io/docs|our docs> now",
    );
  });

  it("converts image links too", () => {
    expect(mdToMrkdwn("![logo](https://x.io/l.png)")).toBe("<https://x.io/l.png|logo>");
  });

  it("turns ATX headings into bold lines", () => {
    expect(mdToMrkdwn("## To unblock this\nbody")).toBe("*To unblock this*\nbody");
    expect(mdToMrkdwn("### Deep heading ###")).toBe("*Deep heading*");
  });

  it("converts unordered list markers to bullets, keeping indent", () => {
    expect(mdToMrkdwn("- first\n- second")).toBe("•   first\n•   second");
    expect(mdToMrkdwn("  * nested")).toBe("  •   nested");
    expect(mdToMrkdwn("+ plus item")).toBe("•   plus item");
  });

  it("converts ~~strike~~ to single-tilde", () => {
    expect(mdToMrkdwn("~~gone~~")).toBe("~gone~");
  });

  it("does NOT rewrite markdown inside inline code", () => {
    expect(mdToMrkdwn("use `**not bold**` literally")).toBe("use `**not bold**` literally");
  });

  it("does NOT rewrite markdown inside fenced code", () => {
    const input = "```\nconst x = **a**;\n[y](z)\n```";
    expect(mdToMrkdwn(input)).toBe(input);
  });

  it("leaves code chip emails untouched (already correct in Slack)", () => {
    expect(mdToMrkdwn("designate a support email (e.g. `support@upcar.ai`)")).toBe(
      "designate a support email (e.g. `support@upcar.ai`)",
    );
  });

  it("passes through already-Slack text and ordered lists unchanged", () => {
    expect(mdToMrkdwn("the *agent* run failed")).toBe("the *agent* run failed");
    expect(mdToMrkdwn("1. one\n2. two")).toBe("1. one\n2. two");
    expect(mdToMrkdwn("_italic_ stays")).toBe("_italic_ stays");
  });

  it("handles empty / whitespace input", () => {
    expect(mdToMrkdwn("")).toBe("");
    expect(mdToMrkdwn("   ")).toBe("   ");
  });

  it("converts multi-line bold across a realistic reply", () => {
    const input = [
      "No customer-facing escalation email exists yet **today**.",
      "",
      "**To unblock this:** designate a support email and document it.",
      "",
      "- Add to tier docs",
      "- Surface in-app",
    ].join("\n");
    const out = mdToMrkdwn(input);
    expect(out).toContain("exists yet *today*.");
    expect(out).toContain("*To unblock this:* designate");
    expect(out).toContain("•   Add to tier docs");
    expect(out).not.toContain("**");
  });
});

describe("mdToMrkdwn — tables", () => {
  it("renders a table with every value still bound to its column header", () => {
    const md = [
      "| Metric | Your number | Turo |",
      "|---|---|---|",
      "| GMV | $1.2M | $2.5B |",
    ].join("\n");
    const out = mdToMrkdwn(md);
    expect(out).not.toContain("|---|");
    expect(out).not.toMatch(/\|\s*Metric\s*\|/);
    expect(out).toContain("*GMV*");
    expect(out).toContain("•   Your number: $1.2M");
    expect(out).toContain("•   Turo: $2.5B");
  });

  it("NEVER drops the column header on a 2-col table (a benchmark is not an actual)", () => {
    const md = ["| Metric | Benchmark |", "|---|---|", "| Take rate | 25% |"].join("\n");
    const out = mdToMrkdwn(md);
    expect(out).toContain("*Take rate*");
    expect(out).toContain("•   Benchmark: 25%");
    expect(out).not.toMatch(/\*Take rate\*:\s*25%/);
  });

  it("leaves a pipe-bearing line that is NOT a table alone", () => {
    const md = "run `a | b` or use the | character";
    expect(mdToMrkdwn(md)).toContain("|");
  });
});

describe("mdToMrkdwn — approx tilde must not strike through numbers", () => {
  it("renders the founder's GMV line without strikethrough", () => {
    const out = mdToMrkdwn("~$1.2M ARR (~$23K/wk)");
    expect(out).toBe("≈$1.2M ARR (≈$23K/wk)");
    expect(out).not.toContain("~");
  });

  it("converts ~600 hosts", () => {
    expect(mdToMrkdwn("~600 hosts")).toBe("≈600 hosts");
  });

  it("does NOT mangle a filesystem path (every engineer post has one)", () => {
    expect(mdToMrkdwn("run ~/scripts/deploy.sh now")).toBe("run ~/scripts/deploy.sh now");
  });

  it("preserves REAL strikethrough (~~gone~~ -> ~gone~) and stays idempotent", () => {
    const once = mdToMrkdwn("~~gone~~");
    expect(once).toBe("~gone~");
    expect(mdToMrkdwn(once)).toBe("~gone~");
  });

  it("leaves tildes inside code spans byte-for-byte", () => {
    expect(mdToMrkdwn("use `~$HOME` here")).toBe("use `~$HOME` here");
  });
});

describe("mdToMrkdwn — horizontal rules", () => {
  it("drops --- instead of printing literal dashes", () => {
    const out = mdToMrkdwn("above\n\n---\n\nbelow");
    expect(out).not.toMatch(/^---$/m);
    expect(out).toContain("above");
    expect(out).toContain("below");
  });
});

describe("mdToMrkdwn — praxis-action deep-links", () => {
  const SETTINGS = "https://www.zaviagent.com/workspace?tab=settings";

  it("rewrites connect: to a real clickable settings deep-link", () => {
    expect(mdToMrkdwn("[Connect GitHub](/__praxis_action__/connect:github)")).toBe(
      `<${SETTINGS}#connector-github|Connect GitHub>`,
    );
  });

  it("rewrites reauth: the same way", () => {
    expect(mdToMrkdwn("[Reconnect Jira](/__praxis_action__/reauth:jira)")).toBe(
      `<${SETTINGS}#connector-jira|Reconnect Jira>`,
    );
  });

  it("maps add-repo: to the GitHub connector tile", () => {
    expect(
      mdToMrkdwn("[Add acme/site](/__praxis_action__/add-repo:acme/site)"),
    ).toBe(`<${SETTINGS}#connector-github|Add acme/site>`);
  });

  it("never leaves the raw sentinel in Slack-bound output", () => {
    const out = mdToMrkdwn(
      "Repo access is missing. [Connect GitHub](/__praxis_action__/connect:github) then retry.",
    );
    expect(out).not.toContain("__praxis_action__");
    expect(out).not.toContain("</praxis_action");
  });

  it("does not let an injected query param into the emitted URL", () => {
    const out = mdToMrkdwn(
      "[Connect Jira](/__praxis_action__/connect:jira&next=https://evil.test)",
    );
    expect(out).toBe(`<${SETTINGS}#connector-jira|Connect Jira>`);
    expect(out).not.toContain("evil.test");
  });

  it("degrades an unknown verb/slug to plain text, not a guessed link", () => {
    expect(mdToMrkdwn("[Connect Notion](/__praxis_action__/connect:notion)")).toBe(
      "Connect Notion in Settings → Connectors",
    );
    expect(mdToMrkdwn("[Do Thing](/__praxis_action__/delete:linear)")).toBe(
      "Do Thing in Settings → Connectors",
    );
  });

  it("leaves ordinary absolute links untouched", () => {
    expect(mdToMrkdwn("[Docs](https://example.com/x)")).toBe(
      "<https://example.com/x|Docs>",
    );
  });

  it("rewrites a mimicked mrkdwn-form action link (intact sentinel)", () => {
    expect(
      mdToMrkdwn("Fix it here: </__praxis_action__/connect:github|Connect GitHub>"),
    ).toBe(`Fix it here: <${SETTINGS}#connector-github|Connect GitHub>`);
  });

  it("rewrites the underscore-eaten variant a human might paste back", () => {
    expect(
      mdToMrkdwn("Fix it here: </praxis_action/connect:github|Connect GitHub>"),
    ).toBe(`Fix it here: <${SETTINGS}#connector-github|Connect GitHub>`);
  });

  it("degrades an unknown mrkdwn-form verb to plain text", () => {
    expect(mdToMrkdwn("</__praxis_action__/delete:linear|Do Thing>")).toBe(
      "Do Thing in Settings → Connectors",
    );
  });

  it("rewrites a bare relative action URL with no label", () => {
    expect(mdToMrkdwn("go to /__praxis_action__/connect:stripe to fix")).toBe(
      `go to ${SETTINGS}#connector-stripe to fix`,
    );
    expect(mdToMrkdwn("go to /__praxis_action__/frobnicate:x to fix")).toBe(
      "go to Settings → Connectors to fix",
    );
  });
});

describe("mrkdwnActionLinksToMarkdown", () => {
  it("converts a posted mrkdwn action link back to the canonical markdown form", () => {
    expect(
      mrkdwnActionLinksToMarkdown(
        "You need to reconnect it: </__praxis_action__/connect:github|Connect GitHub>",
      ),
    ).toBe(
      "You need to reconnect it: [Connect GitHub](/__praxis_action__/connect:github)",
    );
  });

  it("also repairs the underscore-eaten variant", () => {
    expect(
      mrkdwnActionLinksToMarkdown("</praxis_action/reauth:jira|Reconnect Jira>"),
    ).toBe("[Reconnect Jira](/__praxis_action__/reauth:jira)");
  });

  it("leaves ordinary text and real mrkdwn links untouched", () => {
    const s = "see <https://example.com/x|Docs> and reply here";
    expect(mrkdwnActionLinksToMarkdown(s)).toBe(s);
  });
});
