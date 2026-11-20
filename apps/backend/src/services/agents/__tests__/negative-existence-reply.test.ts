
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  verifyNegativeExistence,
  removeFalseAbsenceSentences,
  __clearNegExistenceCache,
  type NegativeExistenceClaim,
  type GroundedClaim,
  type NegativeExistenceEvidence,
} from "../negative-existence-grounding-verifier";

const REPLY = "I checked and there is no `respondToCarReview` endpoint.";
const MARKER = "<!--engineer-neg-existence-correction-->";

function groundReturning(
  build: (c: NegativeExistenceClaim) => GroundedClaim,
): (t: string, claims: NegativeExistenceClaim[]) => Promise<GroundedClaim[]> {
  return async (_t, claims) => claims.map(build);
}

const evidenceFor = (
  c: NegativeExistenceClaim,
  over: Partial<NegativeExistenceEvidence> = {},
): NegativeExistenceEvidence => ({
  claimed_absent: c.symbol,
  matched_symbol: c.symbol,
  repo: "owner/repo",
  path: "src/cars.route.ts",
  line: 96,
  hit_type: "route",
  checked_ref: "HEAD",
  match_mode: "literal",
  ...over,
});

beforeEach(() => __clearNegExistenceCache());

describe("verifyNegativeExistence", () => {
  it("no negative-existence claim in the reply → untouched, grounder never called", async () => {
    const ground = vi.fn(groundReturning((c) => ({ claim: c.claim, exists: true, evidence: evidenceFor(c) })));
    const r = await verifyNegativeExistence({
      tenant_id: "t1",
      reply: "I opened a PR that adds the endpoint you asked for.",
      deps: { ground },
    });
    expect(r.hedged).toBe(false);
    expect(r.flags.has_claim).toBe(false);
    expect(ground).not.toHaveBeenCalled();
  });

  it("claim + grounder proves it EXISTS (literal) → prepends a Correction banner citing the location", async () => {
    const ground = vi.fn(groundReturning((c) => ({ claim: c.claim, exists: true, evidence: evidenceFor(c) })));
    const r = await verifyNegativeExistence({ tenant_id: "t1", reply: REPLY, deps: { ground } });
    expect(r.hedged).toBe(true);
    expect(r.text).toContain(MARKER);
    expect(r.text).toContain("respondToCarReview");
    expect(r.text).toContain("src/cars.route.ts:96");
    expect(r.text).toContain(REPLY);
    expect(r.flags.corrected_symbols).toContain("respondToCarReview");
    expect(ground).toHaveBeenCalledTimes(1);
  });

  it("wrong-name (semantic) match → banner names the real symbol", async () => {
    const reply = "I checked and there is no `replyToReview` endpoint.";
    const ground = vi.fn(
      groundReturning((c) => ({
        claim: c.claim,
        exists: true,
        evidence: evidenceFor(c, { matched_symbol: "respondToCarReview", match_mode: "semantic" }),
      })),
    );
    const r = await verifyNegativeExistence({ tenant_id: "t1", reply, deps: { ground } });
    expect(r.hedged).toBe(true);
    expect(r.text).toContain("it exists as `respondToCarReview`");
  });

  it("a TRUE refusal (exists:false) → untouched", async () => {
    const ground = vi.fn(groundReturning((c) => ({ claim: c.claim, exists: false })));
    const r = await verifyNegativeExistence({ tenant_id: "t1", reply: REPLY, deps: { ground } });
    expect(r.hedged).toBe(false);
    expect(r.text).toBe(REPLY);
  });

  it("unverifiable (undefined — no connector / search miss) → untouched", async () => {
    const ground = vi.fn(groundReturning((c) => ({ claim: c.claim, exists: undefined })));
    const r = await verifyNegativeExistence({ tenant_id: "t1", reply: REPLY, deps: { ground } });
    expect(r.hedged).toBe(false);
    expect(r.text).toBe(REPLY);
  });

  it("timeout → fail-open (reply untouched), never hangs", async () => {
    const ground = vi.fn(() => new Promise<GroundedClaim[]>(() => {}));
    const r = await verifyNegativeExistence({
      tenant_id: "t1",
      reply: REPLY,
      deps: { ground, timeoutMs: 10 },
    });
    expect(r.hedged).toBe(false);
    expect(r.text).toBe(REPLY);
  });

  it("idempotent — a reply already carrying the marker is not re-grounded", async () => {
    const ground = vi.fn(groundReturning((c) => ({ claim: c.claim, exists: true, evidence: evidenceFor(c) })));
    const r = await verifyNegativeExistence({
      tenant_id: "t1",
      reply: `${MARKER}\n${REPLY}`,
      deps: { ground },
    });
    expect(r.hedged).toBe(false);
    expect(ground).not.toHaveBeenCalled();
  });

  it("per-tenant cache — the same (tenant, symbol) is grounded ONCE across replies", async () => {
    const ground = vi.fn(groundReturning((c) => ({ claim: c.claim, exists: true, evidence: evidenceFor(c) })));
    const a = await verifyNegativeExistence({ tenant_id: "t1", reply: REPLY, deps: { ground } });
    const b = await verifyNegativeExistence({ tenant_id: "t1", reply: REPLY, deps: { ground } });
    expect(a.hedged).toBe(true);
    expect(b.hedged).toBe(true);
    expect(ground).toHaveBeenCalledTimes(1);
  });

  it("cache expires after the TTL (re-grounds)", async () => {
    let t = 1_000_000;
    const now = () => t;
    const ground = vi.fn(groundReturning((c) => ({ claim: c.claim, exists: true, evidence: evidenceFor(c) })));
    await verifyNegativeExistence({ tenant_id: "t1", reply: REPLY, deps: { ground, now } });
    t += 10 * 60_000;
    await verifyNegativeExistence({ tenant_id: "t1", reply: REPLY, deps: { ground, now } });
    expect(ground).toHaveBeenCalledTimes(2);
  });

  it("no tenant_id → untouched", async () => {
    const ground = vi.fn(groundReturning((c) => ({ claim: c.claim, exists: true, evidence: evidenceFor(c) })));
    const r = await verifyNegativeExistence({ tenant_id: "", reply: REPLY, deps: { ground } });
    expect(r.hedged).toBe(false);
    expect(ground).not.toHaveBeenCalled();
  });
});

describe("verifyNegativeExistence — without_false_claims (delivered text)", () => {
  const exists = vi.fn(groundReturning((c) => ({ claim: c.claim, exists: true, evidence: evidenceFor(c) })));

  it("removes only the proven-false sentence", async () => {
    const reply = `The review form posts to the reviews API. ${REPLY} I can add the handler next.`;
    const r = await verifyNegativeExistence({ tenant_id: "t1", reply, deps: { ground: exists } });
    expect(r.hedged).toBe(true);
    expect(r.without_false_claims).toBe(
      "The review form posts to the reviews API. I can add the handler next.",
    );
    expect(r.without_false_claims).not.toMatch(/⚠|Correction/);
    expect(r.flags.false_claim_symbols).toEqual(["respondToCarReview"]);
  });

  it("a reply that was only the false claim → a plain statement of where it is", async () => {
    const r = await verifyNegativeExistence({ tenant_id: "t1", reply: REPLY, deps: { ground: exists } });
    expect(r.without_false_claims).toBe(
      "I found it in your repo: `respondToCarReview` (src/cars.route.ts:96).",
    );
  });

  it("false positive: a TRUE absence (exists:false) → byte-identical", async () => {
    const ground = vi.fn(groundReturning((c) => ({ claim: c.claim, exists: false })));
    const r = await verifyNegativeExistence({ tenant_id: "t1", reply: REPLY, deps: { ground } });
    expect(r.hedged).toBe(false);
    expect(r.without_false_claims).toBe(REPLY);
  });

  it("removal binds (kind, symbol): 'no `foo` endpoint' goes, 'no `foo` table' (not disproved) stays", async () => {
    const ground = vi.fn(
      groundReturning((c) =>
        c.kind === "endpoint"
          ? { claim: c.claim, exists: true, evidence: evidenceFor(c) }
          : { claim: c.claim, exists: false },
      ),
    );
    const reply = "There is no `foo` endpoint. There is no `foo` table.";
    const r = await verifyNegativeExistence({ tenant_id: "t1", reply, deps: { ground } });
    expect(r.hedged).toBe(true);
    expect(r.flags.false_claims).toEqual([{ kind: "endpoint", symbol: "foo" }]);
    expect(r.without_false_claims).toBe("There is no `foo` table.");
    expect(removeFalseAbsenceSentences(reply, r.flags.false_claims)).toBe("There is no `foo` table.");
  });

  it("false positive: an absence claim about a DIFFERENT symbol and fenced code stay", () => {
    const text =
      "There is no `archiveListing` endpoint.\n\n```\n// there is no `respondToCarReview` endpoint\n```\n" +
      REPLY;
    expect(removeFalseAbsenceSentences(text, ["respondToCarReview"])).toBe(
      "There is no `archiveListing` endpoint.\n\n```\n// there is no `respondToCarReview` endpoint\n```",
    );
  });
});
