import { describe, expect, it } from "vitest";
import { precedingTurnChunks, shouldDropPrecedingTurn } from "../_reply-format";

const LEAKED_IN_PROD: readonly string[] = [
  "I'll investigate this. First let me emit my predicted plan, then load the tools I need.",
  "The remote is upcar-private. Let me find where the Private Rentals toggle should live.",
  "**Step 2** — Wire the toggle into `HostBilling.tsx`. Add imports first:",
  "**Step 3** — Add `hostSubdomain` state and the fetch effect:",
  "Only pre-existing jest-type errors in test files. Let me confirm my changes typecheck clean:",
  "My files are clean. Let me now check the test suite:",
  "Pre-existing failures. Let me restore `package-lock.json` so it's not in the PR:",
  "Backend installed. Let me try typecheck and a targeted test:",
  "Backend typecheck clean. Let me run the existing tenantHostContext test:",
  "BOM restored, diff clean. Let me re-run typecheck to confirm the BOM didn't break anything:",
  "Got both repos and both users. Now reading the pixel implementation in each.",
  "PDF is generated (23KB). Now opening a group DM with Ravi + Furqan and sending it:",
  "Good — `_id` is the string trip number. Let me pull trip 12863 with key fields.",
  "Now let me look at the `HostBilling.tsx` file top and its content around the plan summary",
  "Now let me implement. First the backend cache module:",
];

const SCRATCHPAD_WITH_CODE = [
  "**Step 2** — Wire the toggle into `HostBilling.tsx`. Add imports first:",
  "",
  "```tsx",
  "import { PrivateRentalsToggleCard } from './PrivateRentalsToggleCard';",
  "```",
].join("\n");

const REAL_DELIVERABLES: readonly string[] = [
  [
    "Here's the breakdown of the payout failure:",
    "",
    "Three hosts are affected, all on the same Stripe account. The common factor is a",
    "missing external_account on the connected account, which started after the July 2 migration.",
  ].join("\n"),
  [
    "First, the root cause: the webhook handler swallows a 409 and returns 200.",
    "",
    "That means Stripe never retries, so the booking stays unconfirmed forever.",
    "The fix is to let the 409 surface so Stripe's retry schedule takes over.",
  ].join("\n"),
  "Saved to memory. Let me know if you want me to hand this to the engineer.",
];

describe("shouldDropPrecedingTurn — scratchpad never reaches a customer", () => {
  for (const line of LEAKED_IN_PROD) {
    it(`drops verbatim prod leak: ${line.slice(0, 58)}…`, () => {
      expect(shouldDropPrecedingTurn(line)).toBe(true);
    });
  }

  it("drops a scratchpad turn even when it carries a code fence (the inverted escape hatch)", () => {
    expect(shouldDropPrecedingTurn(SCRATCHPAD_WITH_CODE)).toBe(true);
  });

  it("drops narration-over-a-code-block even with NO work verb (the escape hatch's back door)", () => {
    const turn = ["Now here's the change:", "```ts", "const x = 1;", "```"].join("\n");
    expect(shouldDropPrecedingTurn(turn)).toBe(true);
  });

  it("but a genuine multi-line prose breakdown that opens with 'Now,' still survives", () => {
    const turn = [
      "Now, the key risk is the unverified Stripe account.",
      "",
      "Payouts will keep failing until an external account is attached.",
      "Nothing else in the booking flow is affected.",
    ].join("\n");
    expect(shouldDropPrecedingTurn(turn)).toBe(false);
  });

  for (const [i, turn] of REAL_DELIVERABLES.entries()) {
    it(`keeps genuine deliverable #${i + 1}`, () => {
      expect(shouldDropPrecedingTurn(turn)).toBe(false);
    });
  }

  it("'let me know' addresses the customer and is never scratchpad", () => {
    expect(shouldDropPrecedingTurn("Done. Let me know if you want a PR.")).toBe(false);
  });
});

describe("shouldDropPrecedingTurn — never eats a real answer", () => {
  it("keeps an answer that says 'Let me explain' (explanation verb, not work verb)", () => {
    const turn = [
      "Quick answer: Stripe rejected the connected account. Let me explain the two fixes:",
      "",
      "1. Add an external account in Stripe.",
      "2. Retry the payout once the account is verified.",
    ].join("\n");
    expect(shouldDropPrecedingTurn(turn)).toBe(false);
    expect(precedingTurnChunks([turn, "Saved to memory."], false, 2800)).toEqual([]);
    const fullExplanation = [
      "Quick answer: Stripe rejected the connected account. Let me explain the two fixes:",
      "",
      "The connected account has no external_account attached, so every payout attempt",
      "fails at Stripe before it reaches the bank. Nothing is wrong with the payout",
      "amounts themselves — the destination is simply missing, which is why all three",
      "hosts fail identically rather than in a pattern tied to their trips.",
      "",
      "Add an external account in Stripe, then retry the payout once verification clears.",
    ].join("\n");
    expect(precedingTurnChunks([fullExplanation, "Saved to memory."], false, 2800)).toHaveLength(1);
  });

  it("keeps customer guidance shaped as numbered steps (product UI, not source files)", () => {
    const turn = [
      "**Step 2**: Connect GitHub in Settings → Connectors.",
      "Then grant Zavi access to the repository and re-run the engineer.",
    ].join("\n");
    expect(shouldDropPrecedingTurn(turn)).toBe(false);
  });

  it("but still drops a numbered step that walks the agent's own edits", () => {
    expect(
      shouldDropPrecedingTurn("**Step 2** — Wire the toggle into `HostBilling.tsx`."),
    ).toBe(true);
  });

  it("keeps 'I'll run through both' — walking the customer through, not running anything", () => {
    const turn = [
      "Quick answer: there are two options. I'll run through both:",
      "1. Connect GitHub in Settings.",
      "2. Re-run the engineer.",
    ].join("\n");
    expect(shouldDropPrecedingTurn(turn)).toBe(false);
  });

  for (const verb of ["explain", "summarize", "walk you through", "break down", "show you"]) {
    it(`'let me ${verb}' is customer-addressed, never scratchpad`, () => {
      const turn = `Here's the shape of it. Let me ${verb} what happened:\n\nThe payout failed because the account was unverified.\nStripe retries automatically once it clears.`;
      expect(shouldDropPrecedingTurn(turn)).toBe(false);
    });
  }
});

const LEAKED_2026_07_18: readonly string[] = [
  "Now I have a clear picture. Let me also check what's in the `other` category:",
  "Mongo binary can't run in this sandbox (known infra issue). Let me manually verify each of the 16 DEL-697 assertions against the current source:",
  "37/37 pass. Let me also quickly verify no other callers reference the extracted helper by name.",
  '<plan>\n{\n  "summary": "Follow-up on PR #1473: rebuild the backend TS changes.",\n  "steps": ["Check git status on the follow-up branch"]\n}\n</plan>',
  "Shard 4/4 all green (378 passed, 0 failed). Now backend + web typecheck to seal the ship gate.",
  "All 25 tests pass (12 extract-json + 13 meetings-distill). The `expo` tsconfck warning is unrelated preexisting noise. Now run memory-cards test and typecheck.",
  "Typecheck clean. Rerun the distill tests to confirm the cast still works at runtime.",
  "memory-cards-distill: 7/7 pass. Now check the sibling gate test (also imports the distill module) and typecheck.",
  "Adding `APP_URL` to `.env.example`. Since the file is read-blocked, I'll append at the end.",
];

const MUST_SURVIVE_2026_07_18: readonly string[] = [
  "On it. Searching specifically for Zavi's competitive space: AI agents / operating platforms for marketplace operators.",
  "Got it — $1K/month and $2K/month. Re-rendering with the correct structure now.",
  "One flag before I render: it's unclear if **$1K/$2K is monthly** (so $12K–$24K/year total) **or the total annual price**. I've drafted both as annual totals since \"90% cheaper\" implies a deep early-adopter discount. Correct that section before sending.",
  "Fair pushback. Let me actually research this before answering.",
  "The failing test is the private-note-reader-guard — a REGISTRY-in-a-test that requires classifying every new `memory_note` reader. Commit `4f93cc9` added `src/routes/admin/company-facts-suggest.ts` (the Research button behind the admin console) as a new reader, but never registered it. The test's own error message tells you to add it to REGISTRY once you've classified it, which is the whole fix.",
  "Pulled it — your `carArea` field has 4 non-core states in it.",
  "Pulled it — your `carArea` field now has 4 non-core states: AK, HI, NV, OR.",
  "The `budget` column is now $500 — that's the cap you set in March.",
  "Checked your `listings.csv` — 42 rows now, up from 30 last week.",
];

describe("shouldDropPrecedingTurn — 2026-07-18 re-measurement wave", () => {
  for (const line of LEAKED_2026_07_18) {
    it(`drops verbatim prod leak: ${line.slice(0, 52).replace(/\n/g, " ")}…`, () => {
      expect(shouldDropPrecedingTurn(line)).toBe(true);
    });
  }

  for (const line of MUST_SURVIVE_2026_07_18) {
    it(`keeps legitimate progress/answer: ${line.slice(0, 52)}…`, () => {
      expect(shouldDropPrecedingTurn(line)).toBe(false);
    });
  }

  it("drops a control block that opens MID-LINE, not just at line start", () => {
    expect(
      shouldDropPrecedingTurn('Plan accepted. <plan>{"steps":["Check git status"]}</plan>'),
    ).toBe(true);
  });

  it("suppresses run 92df1d18 end-to-end — 3 scratchpad turns in, nothing posted", () => {
    const turns = [
      "Let me check the full schema from the catalog and look for state fields in carlistings:",
      "The `_id` format mismatch is causing the join to fail. Let me check what field in carlistings links to the carId in trips:",
      "Now I have a clear picture. Let me also check what's in the `other` category:",
      "Got it. Here's the full picture from your trips data:\n\n**Yes, you do have bookings outside those 8 states.**",
    ];
    expect(precedingTurnChunks(turns, false, 2800)).toEqual([]);
  });

  it("a lone brief progress line NO LONGER reaches the customer (policy reversed 2026-08-29)", () => {
    const turns = ["On it — digging in now, ~10m. PR incoming.", "Done. Here's the PR: #1234"];
    expect(precedingTurnChunks(turns, false, 2800)).toEqual([]);
  });
});

describe("precedingTurnChunks", () => {
  it("posts nothing when every preceding turn is scratchpad", () => {
    const turns = [...LEAKED_IN_PROD.slice(0, 5), "Here is the final answer."];
    expect(precedingTurnChunks(turns, false, 2800)).toEqual([]);
  });

  it("still posts a genuine preceding turn (long-form)", () => {
    const realBreakdown = [
      "Here's the breakdown of the payout failure:",
      "",
      "Three hosts are affected, all on the same Stripe account. The common factor is a",
      "missing external_account on the connected account, which started after the July 2",
      "migration — before it, payouts routed through the platform account and never",
      "needed a destination on the connected account at all.",
      "",
      "So this is not three separate failures; it is one misconfiguration surfacing",
      "three times. Attaching the external account fixes all three at once.",
    ].join("\n");
    expect(realBreakdown.length).toBeGreaterThan(300);
    expect(precedingTurnChunks([realBreakdown, "Here is the final answer."], false, 2800)).toHaveLength(1);
  });

  it("ACCEPTED COST: a short-but-real preceding turn is suppressed too", () => {
    expect(REAL_DELIVERABLES[0].trim().length).toBeLessThan(300);
    expect(precedingTurnChunks([REAL_DELIVERABLES[0], "Final."], false, 2800)).toEqual([]);
  });

  it("the final turn is never this function's problem — it always delivers separately", () => {
    const turns = [...LEAKED_IN_PROD];
    expect(precedingTurnChunks(turns, false, 2800)).toEqual([]);
  });
});
