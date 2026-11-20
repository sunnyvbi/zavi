
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { sanitizeDurableClaims } from "../absence-sanitizer";

const LIVE = ["stripe", "slack", "github"];

function s(over: Partial<Parameters<typeof sanitizeDurableClaims>[0]>) {
  return sanitizeDurableClaims({
    title: "Ops note",
    body: "b",
    note_type: "tenant_reference",
    liveConnectors: LIVE,
    ...over,
  });
}

describe("no regression — the 2026-06-09 phantom-endpoint incident notes", () => {
  it("still drops a note whose capability claim spans TWO sentences", () => {
    const r = s({
      title: "Sandbox boot blockers in rravi149/upcar",
      body:
        "Two pre-existing repo issues block app_verify sandbox boot. These must be patched alongside the host-review endpoint to unblock the HTTP-route gate.",
      dropBlockedCapability: true,
    });
    expect(r.dropped).toBe(true);
    expect(r.dropReason).toMatch(/across title\/body/);
  });

  it("drops a single-sentence 'endpoint does not exist' durable claim", () => {
    const r = s({
      note_type: "tenant_project",
      title: "Host review reply",
      body: "The reply endpoint does not exist yet and is not implemented in the backend.",
    });
    expect(r.dropped).toBe(true);
  });

  it("drops the SMART-APOSTROPHE form ('doesn’t exist') — LLM output routinely emits U+2019", () => {
    const r = s({
      note_type: "tenant_project",
      title: "Host review reply",
      body: "The reply endpoint doesn’t exist and couldn’t be added.",
    });
    expect(r.dropped).toBe(true);
  });
});

describe("sentence-level excision keeps the true residue", () => {
  it("removes only the lying sentence from a mixed business note", () => {
    const r = s({
      title: "Weekly marketplace ops snapshot",
      body:
        "Last known take-rate: 14.1%. Stripe is not connected to the workspace. GMV run-rate is $412k and the verification bottleneck is onboarding.",
    });
    expect(r.dropped).toBe(false);
    expect(r.body).toContain("14.1%");
    expect(r.body).toContain("GMV run-rate is $412k");
    expect(r.body).not.toMatch(/Stripe is not connected/i);
    expect(r.withheldConnectors).toContain("stripe");
  });

  it("KNOWN GAP — the tenant-product veto lets a connector lie through when the same sentence names payouts/hosts/guests", () => {
    const body = "Stripe is not connected so payouts data is stale.";
    const r = s({ title: "Payouts data", body });
    expect(r.body).toBe(body);
    expect(r.withheldConnectors).toHaveLength(0);
  });

  it("drops the artifact when excision leaves nothing substantive", () => {
    const r = s({ title: "Stripe status", body: "Stripe is not connected." });
    expect(r.dropped).toBe(true);
    expect(r.dropReason).toMatch(/nothing substantive/);
  });

  it("KEEPS a short note we did not touch — the debris check is not a length floor", () => {
    const body = "Jane works at Acme.";
    const r = s({ title: "Acme deal", body });
    expect(r.dropped).toBe(false);
    expect(r.body).toBe(body);
  });
});

describe("write-time must NOT persist the recall-time stub", () => {
  it("leaves no 'operator HAS set up' claim behind", () => {
    const r = s({
      title: "Payouts",
      body:
        "Stripe is not connected to the workspace. Host payouts settle on a T+2 schedule and the reserve is 7%.",
    });
    expect(r.dropped).toBe(false);
    expect(r.body).not.toMatch(/HAS set up/i);
    expect(r.body).not.toMatch(/stale claim withheld/i);
    expect(r.body).toContain("T+2");
  });
});

describe("row-presence disproves SETUP HISTORY, never AVAILABILITY", () => {
  it("KEEPS 'Stripe is offline' — an outage a present row cannot disprove", () => {
    const body = "Stripe is offline because its restricted key was revoked this morning.";
    const r = s({ title: "Payments incident", body });
    expect(r.dropped).toBe(false);
    expect(r.body).toBe(body);
    expect(r.withheldConnectors).toHaveLength(0);
  });

  it("KEEPS 'GitHub is unavailable' and 'Slack is pending'", () => {
    const body =
      "GitHub is unavailable after the install was removed. Slack is pending a token refresh.";
    const r = s({ title: "Connector incidents", body });
    expect(r.dropped).toBe(false);
    expect(r.body).toBe(body);
  });

  it("still EXCISES the setup-history form ('was never set up')", () => {
    const r = s({
      title: "Integration audit",
      body:
        "The quarterly integration audit closed on the 14th with two owners assigned. Slack was never set up for this workspace.",
    });
    expect(r.dropped).toBe(false);
    expect(r.body).not.toMatch(/never set up/i);
    expect(r.body).toContain("quarterly integration audit");
  });
});

describe("the tenant-product veto survives", () => {
  it("KEEPS a claim about the tenant's OWN Stripe Connect payouts product", () => {
    const body = "Stripe Connect is not wired for hosts, so hosts cannot receive payouts yet.";
    const r = s({ title: "Payouts roadmap", body });
    expect(r.dropped).toBe(false);
    expect(r.body).toBe(body);
  });
});

describe("scope — only durable tenant fact types are touched", () => {
  it("leaves agent_feedback alone (the CORRECT home for a blocked-investigation)", () => {
    const body =
      "I concluded the endpoint was missing and stalled; next time grep the live code before concluding absence.";
    const r = s({ note_type: "agent_feedback", title: "Learning", body });
    expect(r.dropped).toBe(false);
    expect(r.body).toBe(body);
  });

  it("leaves operator_preference alone", () => {
    const body = "Operator wants the reply endpoint shipped even though it does not exist yet.";
    const r = s({ note_type: "operator_preference", title: "Pref", body });
    expect(r.dropped).toBe(false);
    expect(r.body).toBe(body);
  });
});

describe("read-truncation evidence gate", () => {
  const gaAbsence = {
    title: "Analytics setup",
    body:
      "The marketing site ships a full consent banner and a cookie policy page. No Google Analytics or GTM was found in the repo.",
  };

  it("drops the GA absence when the run was READ-TRUNCATED", () => {
    const r = s({ ...gaAbsence, readBudgetRefused: true });
    expect(r.dropped).toBe(false);
    expect(r.body).not.toMatch(/No Google Analytics/i);
    expect(r.body).toContain("consent banner");
  });

  it("KEEPS the identical claim on a clean run (absence rested on real reads)", () => {
    const r = s({ ...gaAbsence, readBudgetRefused: false });
    expect(r.dropped).toBe(false);
    expect(r.body).toBe(gaAbsence.body);
  });

  it("KEEPS a verified 'no open PRs' on a non-truncated run", () => {
    const body = "There are no open PRs against the mobile repo as of this morning's sweep.";
    const r = s({ title: "Repo state", body, readBudgetRefused: false });
    expect(r.body).toBe(body);
  });
});

describe("a poisoned TITLE cannot slip past body-only redaction", () => {
  it("drops when the title asserts a disproven connector state", () => {
    const r = s({
      title: "Stripe is not connected",
      body: "Some otherwise harmless and reasonably long body text about payouts.",
    });
    expect(r.dropped).toBe(true);
    expect(r.dropReason).toMatch(/title/);
  });

  it("drops a bare-'missing' capability title under the engineer scope", () => {
    const args = {
      title: "Reply endpoint is missing",
      body: "Some otherwise harmless and reasonably long body text about reviews.",
    };
    expect(s({ ...args, dropBlockedCapability: true }).dropped).toBe(true);
    expect(s(args).dropped).toBe(false);
  });
});

describe("no live connectors ⇒ connector rule is inert (behaviour unchanged)", () => {
  it("keeps a 'not connected' claim about a connector the tenant genuinely lacks", () => {
    const body = "Quickbooks is not connected, so revenue reconciliation is still manual.";
    const r = s({ title: "Finance ops", body, liveConnectors: [] });
    expect(r.dropped).toBe(false);
    expect(r.body).toBe(body);
  });
});

const OLD_ABSENCE_VERB =
  /\b(?:block(?:ed|s)?|missing|does ?n['o]?t exist|not implemented|unimplemented|unavailable|could ?n['o]?t (?:locate|find|implement|ship|add)|still missing|pending|held by|not (?:yet )?(?:live|merged|available|implemented|reachable)|cannot be (?:implemented|shipped|added)|attempted but|never (?:merged|shipped|implemented))\b/i;
const OLD_CAP_NOUN = /\b(?:endpoint|route|api|backend|capability|handler|controller)\b/i;

function oldWouldDrop(title: string, body: string): boolean {
  const t = `${title}\n${body}`;
  return OLD_ABSENCE_VERB.test(t) && OLD_CAP_NOUN.test(t);
}

describe("differential invariant — no escape the old whole-artifact guard caught", () => {
  const cases: Array<[string, string, string]> = [
    ["verb and noun in different SENTENCES", "Sandbox boot blockers", "Two repo issues block app_verify boot. These need the host-review endpoint."],
    ["verb and noun split across TITLE and BODY", "Endpoint status", "This is still missing."],
    ["reversed — noun in body, verb in title", "Still missing", "The reply endpoint was the target."],
    ["single sentence", "Reply", "The reply endpoint does not exist."],
  ];

  for (const [name, title, body] of cases) {
    it(`engineer scope: ${name}`, () => {
      expect(oldWouldDrop(title, body)).toBe(true);
      const r = s({ title, body, dropBlockedCapability: true });
      if (!r.dropped) {
        expect(oldWouldDrop(r.title, r.body)).toBe(false);
      }
    });
  }
});

describe("differential invariant — read-truncation guard across boundaries", () => {
  const NEG = /\bno\b[^.?!]*\bfound\b|\bfound\s+no\b/i;

  it("catches a negative-existence claim split across TITLE and BODY", () => {
    const r = s({
      title: "No Google Analytics",
      body: "was found in the repository.",
      readBudgetRefused: true,
    });
    expect(r.dropped || !NEG.test(`${r.title}\n${r.body}`)).toBe(true);
  });

  it("catches a negative-existence claim broken by a NEWLINE", () => {
    const r = s({
      title: "Analytics audit",
      body: "No Google Analytics\nwas found in the repository.",
      readBudgetRefused: true,
    });
    expect(r.dropped || !NEG.test(`${r.title}\n${r.body}`)).toBe(true);
  });
});

describe("the verb split — availability facts survive fleet-wide", () => {
  it("KEEPS 'The API is unavailable during scheduled maintenance' by default", () => {
    const body = "The API is unavailable during scheduled maintenance on Sundays.";
    const r = s({ title: "Maintenance window", body });
    expect(r.dropped).toBe(false);
    expect(r.body).toBe(body);
  });

  it("KEEPS 'the launch is blocked on the vendor API contract' by default", () => {
    const body = "The Q3 launch is blocked on the vendor API contract being signed.";
    const r = s({ title: "Q3 status", body, note_type: "tenant_project" });
    expect(r.dropped).toBe(false);
    expect(r.body).toBe(body);
  });

  it("but STRIPS both when the wider engineer verb set is armed", () => {
    const r = s({
      title: "Maintenance window",
      body: "The API is unavailable during scheduled maintenance on Sundays.",
      dropBlockedCapability: true,
    });
    expect(r.dropped).toBe(true);
  });

  it("STRIPS non-existence claims fleet-wide with no flag", () => {
    const r = s({
      title: "Refunds",
      body: "Refund volume averages 4% of monthly orders. The refunds endpoint does not exist.",
    });
    expect(r.dropped).toBe(false);
    expect(r.body).toContain("4% of monthly orders");
    expect(r.body).not.toMatch(/does not exist/i);
  });
});

describe("fleet-wide collateral limits — common words must not delete real facts", () => {
  it("KEEPS 'the customer's invoice is missing' under an 'API incident' title", () => {
    const body = "The customer's invoice is missing.";
    const r = s({ title: "API incident", body });
    expect(r.dropped).toBe(false);
    expect(r.body).toBe(body);
  });

  it("KEEPS 'The API is healthy, but the invoice is missing.' fleet-wide", () => {
    const body = "The API is healthy, but the customer's invoice is missing.";
    const r = s({ title: "Support note", body });
    expect(r.dropped).toBe(false);
    expect(r.body).toBe(body);
  });

  it("but the ENGINEER scope still drops it — prior behaviour preserved exactly", () => {
    const r = s({
      title: "API incident",
      body: "The customer's invoice is missing.",
      dropBlockedCapability: true,
    });
    expect(r.dropped).toBe(true);
  });

  it("a title that carries the whole non-existence claim still drops fleet-wide", () => {
    const r = s({
      title: "The refunds endpoint does not exist",
      body: "Refund volume averages 4% of monthly orders across the quarter.",
    });
    expect(r.dropped).toBe(true);
    expect(r.dropReason).toMatch(/title/);
  });
});

describe("short-but-real residue survives its neighbour being excised", () => {
  it("keeps 'ARR is $4M.' after the Stripe lie is cut", () => {
    const r = s({ title: "Finance", body: "Stripe is not connected. ARR is $4M." });
    expect(r.dropped).toBe(false);
    expect(r.body).toContain("ARR is $4M.");
    expect(r.body).not.toMatch(/not connected/i);
  });
});

const chatSrc = readFileSync(
  join(__dirname, "../../../../workers/functions/distill-chat-turn.ts"),
  "utf-8",
);
const eventSrc = readFileSync(
  join(__dirname, "../../../../workers/functions/distill-event.ts"),
  "utf-8",
);
const agentRunSrc = readFileSync(
  join(__dirname, "../../../../workers/functions/distill-agent-run.ts"),
  "utf-8",
);

describe("caller wiring", () => {
  it("chat distill SELECTs tool_calls (the guard was inert without it)", () => {
    expect(chatSrc).toMatch(/\.select\("id, tenant_id, agent_slug, trigger, payload, tool_calls"\)/);
  });

  it("chat distill passes readBudgetRefused", () => {
    expect(chatSrc).toMatch(/readBudgetRefused:\s*hasReadFileBudgetRefusal\(/);
  });

  it("chat distill does NOT pass toolCalls — that would arm entity-grounding demotion", () => {
    expect(chatSrc).not.toMatch(/^\s*toolCalls:/m);
  });

  it("the WIDER availability/blocked verb set stays engineer-scoped", () => {
    expect(agentRunSrc).toMatch(/dropUnverifiedAbsenceFacts:\s*run\.agent_slug === "engineer"/);
    expect(chatSrc).not.toMatch(/dropUnverifiedAbsenceFacts:/);
  });

  it("Slack/webhook distill sanitizes BEFORE either write branch", () => {
    expect(eventSrc).toMatch(/sanitizeDurableClaims\(/);
    const sanitizeAt = eventSrc.indexOf("sanitizeDurableClaims(");
    const rpcAt = eventSrc.search(/svc\.rpc\(\s*"distill_slack_event_write"/);
    const writeNoteAt = eventSrc.indexOf("await writeNote(");
    expect(rpcAt).toBeGreaterThan(-1);
    expect(sanitizeAt).toBeGreaterThan(-1);
    expect(sanitizeAt).toBeLessThan(rpcAt);
    expect(sanitizeAt).toBeLessThan(writeNoteAt);
  });
});
