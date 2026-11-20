
import { describe, it, expect } from "vitest";
import {
  verifyExternalArtifactClaims,
  externalArtifactGuardMode,
  extractThreadExcerpt,
  looksLikeExternalArtifact,
} from "../external-artifact-claim-verifier";
import type { ToolCallTrace } from "@/services/tools/types";

const tc = (name: string, output: string): ToolCallTrace =>
  ({ name, output_preview: output, status: "ok" }) as unknown as ToolCallTrace;

const T1_REPLY = `**Subject:** Your rental site, your domain — custom domains are live

Hi [First Name],

Your Private Rents site just got a real upgrade: you can now connect your own custom domain.

Instead of yourbrand.private-rents.com, your renters go straight to rentals.yourbrand.com.

Add one CNAME record at your domain provider pointing to cname.private-rents.com.

Available on Fleet plan and above. If you're on the Solo or Operator plan, you can upgrade at any time.`;

const T1_TOOLS = [
  tc(
    "mcp__server__github__read_file",
    `custom domain settings: host enters domain, adds CNAME record pointing to cname.private-rents.com.
     SSL cert auto-issued. Status: pending -> verifying -> active.
     Gated to Fleet plan and above; Solo and Operator plans see an upgrade prompt.
     Private Rents subdomain: yourbrand.private-rents.com`,
  ),
];

const T2_PROMPT = `## Agent spec
You are the operator.

## Tool: launch_video
Supply \`regions\` (REAL labels — US states: e.g. ["California","Nevada","Texas","Arizona","Florida"]).

## Slack thread so far (most recent last)
User: prepare email announcing the new custom domain feature for private rental product
Zavi: ${T1_REPLY}
User: This is good but lot of people don't know about private rental launch also so maybe add a bit about that as well and also make the email exciting to hosts?

## Recent runs
(prior run — output not included)`;

const T2_USER = `This is good but lot of people don't know about private rental launch also so maybe add a bit about that as well and also make the email exciting to hosts?`;

const T2_REPLY = `**Subject: Big news — Private Rents is live, and your brand just got bigger**

Hey [Host name],

We've been building toward this for a while, and it's finally here. Private Rents is live.

That means your car isn't just available to rent anymore. It can be listed for sale too — same listing, same platform, zero extra work.

We're starting in California (LA and Bay Area), and we're growing fast.

For hosts on Fleet plans and above, you can now connect a custom domain to your Private Rents storefront.

Add one CNAME record pointing to cname.private-rents.com.`;

describe("externalArtifactGuardMode", () => {
  it("defaults to warn (ON), and a typo'd value does not silently disable the guard", () => {
    const prev = process.env.EXTERNAL_ARTIFACT_GUARD_MODE;
    delete process.env.EXTERNAL_ARTIFACT_GUARD_MODE;
    expect(externalArtifactGuardMode()).toBe("warn");
    process.env.EXTERNAL_ARTIFACT_GUARD_MODE = "banana";
    expect(externalArtifactGuardMode()).toBe("warn");
    process.env.EXTERNAL_ARTIFACT_GUARD_MODE = "shadow";
    expect(externalArtifactGuardMode()).toBe("shadow");
    process.env.EXTERNAL_ARTIFACT_GUARD_MODE = "off";
    expect(externalArtifactGuardMode()).toBe("off");
    if (prev === undefined) delete process.env.EXTERNAL_ARTIFACT_GUARD_MODE;
    else process.env.EXTERNAL_ARTIFACT_GUARD_MODE = prev;
  });
});

describe("extractThreadExcerpt — the anti-laundering slice", () => {
  it("returns ONLY the thread block, never the tool-spec boilerplate", () => {
    const excerpt = extractThreadExcerpt(T2_PROMPT);
    expect(excerpt).toContain("cname.private-rents.com");
    expect(excerpt).not.toContain("Nevada");
    expect(excerpt).not.toContain("launch_video");
  });

  it("returns empty when the prompt has no thread block", () => {
    expect(extractThreadExcerpt("## Agent spec\nnothing here")).toBe("");
  });
});

describe("REAL INCIDENT — T2 (the turn that fabricated)", () => {
  const verdict = verifyExternalArtifactClaims({
    reply: T2_REPLY,
    toolCalls: [],
    userMessage: T2_USER,
    promptSnapshot: T2_PROMPT,
  });

  it("fires", () => {
    expect(verdict.hedged).toBe(true);
  });

  it("flags the fabricated geo rollout (the one NOBODY caught)", () => {
    const geo = verdict.flags.find((f) => f.claimClass === "geo_rollout");
    expect(geo).toBeDefined();
    expect(geo!.ungrounded.join(" ")).toMatch(/California|Bay Area/);
  });

  it("flags the fabricated cross-product 'for sale' capability", () => {
    expect(verdict.flags.some((f) => f.claimClass === "product_capability")).toBe(true);
  });

  it("leaves the DRAFT BODY byte-intact — no marker rendered into the copy", () => {
    expect(verdict.text.endsWith(T2_REPLY)).toBe(true);
    expect(verdict.text).not.toMatch(/\[UNVERIFIED\]/);
  });

  it("addresses the banner to the human reviewer, above the artifact", () => {
    expect(verdict.text.indexOf("Unverified claims")).toBeLessThan(
      verdict.text.indexOf("Subject:"),
    );
  });

  it("does NOT flag the legitimate facts carried forward from the vetted T1 draft", () => {
    const all = verdict.flags.flatMap((f) => f.ungrounded).join(" ");
    expect(all).not.toMatch(/CNAME/i);
    expect(all).not.toMatch(/Fleet/i);
  });
});

describe("REAL INCIDENT — T1 (the grounded turn) must stay clean", () => {
  it("does not fire on a draft whose facts all trace to tool output", () => {
    const verdict = verifyExternalArtifactClaims({
      reply: T1_REPLY,
      toolCalls: T1_TOOLS,
      userMessage: "prepare email announcing the new custom domain feature for private rental product",
      promptSnapshot: "## Agent spec\nno thread yet",
    });
    expect(verdict.hedged).toBe(false);
    expect(verdict.text).toBe(T1_REPLY);
  });
});

describe("precision — must not flag ordinary work", () => {
  it("ignores replies that are not customer-facing artifacts", () => {
    const verdict = verifyExternalArtifactClaims({
      reply: "Trip 16288 host earnings are $900. The Fleet plan gate is enforced in the UI.",
      toolCalls: [],
      userMessage: "how much is the host earnings for trip 16288?",
      promptSnapshot: "",
    });
    expect(verdict.hedged).toBe(false);
  });

  it("does not flag a pure tone rewrite that adds NO new facts", () => {
    const toneOnly = `**Subject:** Your domain, your brand

Hi [First Name],

Your Private Rents site can now run on your own domain. Add one CNAME record pointing to cname.private-rents.com. Available on Fleet plan and above.`;
    const verdict = verifyExternalArtifactClaims({
      reply: toneOnly,
      toolCalls: [],
      userMessage: "make it punchier",
      promptSnapshot: T2_PROMPT,
    });
    expect(verdict.hedged).toBe(false);
  });

  it("does not flag hypotheticals or the agent's own offers to the human", () => {
    const verdict = verifyExternalArtifactClaims({
      reply: `**Subject:** Draft

Want me to add a version that says we're launching in Texas? I can add it if you confirm.`,
      toolCalls: [],
      userMessage: "draft an email",
      promptSnapshot: "",
    });
    expect(verdict.hedged).toBe(false);
  });

  it("treats a user-supplied fact as grounded (they told us)", () => {
    const verdict = verifyExternalArtifactClaims({
      reply: `**Subject:** We're live in Arizona

Hi there — Upcar is now live in Arizona.`,
      toolCalls: [],
      userMessage: "write an email announcing that we just launched in Arizona",
      promptSnapshot: "",
    });
    expect(verdict.hedged).toBe(false);
  });
});

describe("fail-safe shape", () => {
  it("returns the input untouched on empty reply", () => {
    const v = verifyExternalArtifactClaims({ reply: "" });
    expect(v.hedged).toBe(false);
    expect(v.flags).toEqual([]);
  });

  it("tolerates missing optional fields", () => {
    expect(() => verifyExternalArtifactClaims({ reply: "Subject: hi\n\nWe are live." })).not.toThrow();
  });
});

describe("looksLikeExternalArtifact", () => {
  it("detects an artifact request in the user message", () => {
    expect(looksLikeExternalArtifact("", "prepare email announcing the new feature")).toBe(true);
    expect(looksLikeExternalArtifact("", "draft a blast to all hosts")).toBe(true);
  });
  it("detects an email-shaped draft in the reply", () => {
    expect(looksLikeExternalArtifact("**Subject:** hello\n\nbody", "anything")).toBe(true);
  });
  it("stays out of ordinary Q&A", () => {
    expect(looksLikeExternalArtifact("Host earnings are $900.", "how much did the host earn?")).toBe(false);
  });
});
