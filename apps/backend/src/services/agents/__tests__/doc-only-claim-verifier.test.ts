import { describe, it, expect } from "vitest";
import { reshapeDocOnlyClaims, isDocOnlyFromTrace, verifyDocOnlyClaims } from "../doc-only-claim-verifier";

const INCIDENT_REPLY = `Here's how co-host earnings work end to end.

The split goes live immediately once the owner saves it.
The co-host gets an email and a push notification.

| Capability | Value |
|---|---|
| Max percent | 50 |`;

describe("doc-only claim reshaping", () => {
  it("attributes the incident's two false claims instead of asserting them", () => {
    const out = reshapeDocOnlyClaims(INCIDENT_REPLY, true);
    expect(out.changed).toBe(true);
    expect(out.text).toMatch(/Per the spec, the split goes live immediately/);
    expect(out.text).toMatch(/Per the spec, the co-host gets an email/);
    expect(out.reshaped).toBe(2);
  });

  it("attributes in-sentence only — no closing disclaimer, and a second pass is a no-op", () => {
    const out = reshapeDocOnlyClaims(INCIDENT_REPLY, true);
    expect(out.text).not.toMatch(/Not verified|Unverified|⚠/);
    const again = reshapeDocOnlyClaims(out.text, true);
    expect(again.changed).toBe(false);
    expect(again.text).toBe(out.text);
  });

  it("does nothing at all when the run read real source", () => {
    const out = reshapeDocOnlyClaims(INCIDENT_REPLY, false);
    expect(out.changed).toBe(false);
    expect(out.text).toBe(INCIDENT_REPLY);
  });

  it("leaves an answer that is already about the spec completely alone", () => {
    const specAnswer = `The spec says the split applies immediately.
According to the plan, three co-hosts are the maximum.
The design doc proposes a 50% ceiling.`;
    const out = reshapeDocOnlyClaims(specAnswer, true);
    expect(out.changed).toBe(false);
    expect(out.text).toBe(specAnswer);
  });

  it("leaves hedged and future-tense sentences alone", () => {
    const hedged = `This will ship behind a flag.
The owner is supposed to tick a consent box.
That behaviour is not verified.`;
    expect(reshapeDocOnlyClaims(hedged, true).changed).toBe(false);
  });

  it("never rewrites tables, headings, quotes or code", () => {
    const structured = `# Co-host earnings

| Field | Value |
|---|---|
| percent | is 50 |

\`\`\`ts
const x = getSplit(); // gets the split
\`\`\`

> the split is applied at payout`;
    const out = reshapeDocOnlyClaims(structured, true);
    expect(out.text).not.toMatch(/Per the spec, \|/);
    expect(out.text).not.toMatch(/Per the spec, const/);
    expect(out.text).not.toMatch(/Per the spec, # /);
  });

  it("keeps list shape when it attributes a bullet", () => {
    const bullets = `- The owner receives the remainder.
- The co-host receives their share.`;
    const out = reshapeDocOnlyClaims(bullets, true);
    expect(out.text).toMatch(/^- Per the spec, the owner receives/m);
    expect(out.text).toMatch(/^- Per the spec, the co-host receives/m);
  });

  it("does not lowercase a proper noun when attributing", () => {
    const out = reshapeDocOnlyClaims("Stripe sends the transfer at 3 AM.", true);
    expect(out.text).toMatch(/Per the spec, Stripe sends/);
  });

  it("is idempotent — a re-scanned reply is never reshaped twice", () => {
    const once = reshapeDocOnlyClaims(INCIDENT_REPLY, true);
    const twice = reshapeDocOnlyClaims(once.text, true);
    expect(twice.changed).toBe(false);
    expect(twice.text).toBe(once.text);
  });

  it("adds no footer when it found nothing to attribute", () => {
    const out = reshapeDocOnlyClaims("Hello! What would you like to look at?", true);
    expect(out.changed).toBe(false);
    expect(out.text).not.toMatch(/Not verified/);
  });

  it("handles an empty reply without throwing", () => {
    expect(reshapeDocOnlyClaims("", true).changed).toBe(false);
  });
});

function read(path: string, status: "ok" | "tool_error" = "ok") {
  return {
    name: "mcp__server__github__read_file",
    input_preview: JSON.stringify({ owner: "o", repo: "r", path }),
    output_preview: "{}",
    ms: 1,
    status,
  } as never;
}
const search = {
  name: "mcp__server__github__search_code",
  input_preview: JSON.stringify({ owner: "o", repo: "r", query: "cohost earnings" }),
  output_preview: "{}",
  ms: 1,
  status: "ok",
} as never;

describe("isDocOnlyFromTrace", () => {
  it("replays the incident trace: 8 doc reads, zero source reads", () => {
    const trace = [
      search,
      read("docs/superpowers/plans/2026-09-11-cohost-earnings-split.md"),
      ...Array.from({ length: 7 }, () =>
        read("docs/superpowers/specs/2026-09-11-cohost-earnings-split-spec.md"),
      ),
    ];
    expect(isDocOnlyFromTrace(trace)).toBe(true);
  });

  it("one real source read is enough to stop being doc-only", () => {
    expect(
      isDocOnlyFromTrace([
        read("docs/plan.md"),
        read("apps/backend/src/services/cohostSplit/splitMath.ts"),
      ]),
    ).toBe(false);
  });

  it("a run that opened nothing is NOT doc-only — that is a different failure", () => {
    expect(isDocOnlyFromTrace([])).toBe(false);
    expect(isDocOnlyFromTrace([search])).toBe(false);
    expect(isDocOnlyFromTrace(undefined)).toBe(false);
  });

  it("a FAILED read read nothing, so it cannot make a run doc-only", () => {
    expect(isDocOnlyFromTrace([read("docs/plan.md", "tool_error")])).toBe(false);
  });

  it("survives an unparseable input preview without throwing", () => {
    const bad = { name: "github__read_file", input_preview: "{not json", output_preview: "{}", ms: 1, status: "ok" } as never;
    expect(isDocOnlyFromTrace([bad])).toBe(false);
  });
});

describe("verifyDocOnlyClaims entry point", () => {
  const docTrace = [read("docs/superpowers/specs/spec.md")];

  it("fires for operator on a doc-only run", () => {
    const out = verifyDocOnlyClaims({
      agentSlug: "operator",
      text: "The split goes live immediately.",
      toolCalls: docTrace,
    });
    expect(out.changed).toBe(true);
    expect(out.text).toMatch(/Per the spec, the split goes live/);
  });

  it("does not fire for an agent outside the allowlist", () => {
    const out = verifyDocOnlyClaims({
      agentSlug: "research",
      text: "The split goes live immediately.",
      toolCalls: docTrace,
    });
    expect(out.changed).toBe(false);
  });

  it("does not fire when the run read source", () => {
    const out = verifyDocOnlyClaims({
      agentSlug: "operator",
      text: "The split goes live immediately.",
      toolCalls: [read("apps/backend/src/services/cohostSplit/splitMath.ts")],
    });
    expect(out.changed).toBe(false);
  });
});
