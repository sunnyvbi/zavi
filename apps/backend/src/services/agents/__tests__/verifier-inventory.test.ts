import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";

type Bucket =
  | "chat+terminal"
  | "terminal-only"
  | "delivery-only"
  | "eval-only";

const CLASSIFICATION: Record<string, { bucket: Bucket; note: string }> = {
  "doc-only-claim-verifier.ts": {
    bucket: "chat+terminal",
    note: "pure sync over {text, toolCalls}; both seams wired 2026-09-15. Derives doc-only from the TRACE, not the in-memory receipt ledger, because the chat seam has no run_id. Operator-only allowlist.",
  },
  "cap-grounding-verifier.ts": {
    bucket: "chat+terminal",
    note: "pure sync; chat seam added 2026-07-21",
  },
  "roas-sample-grounding-verifier.ts": {
    bucket: "chat+terminal",
    note: "pure sync; chat seam added 2026-07-21",
  },
  "capped-aggregate-verifier.ts": {
    bucket: "chat+terminal",
    note: "pure sync; both seams wired 2026-09-07. Fleet-wide gate (no agent allowlist) — the run that shipped a wrong account ROAS off a 2-of-21 page was `operator`, not performance-marketer.",
  },
  "fabricated-blocker-verifier.ts": {
    bucket: "chat+terminal",
    note: "pure sync; chat seam added 2026-07-21",
  },
  "unverified-absence-verifier.ts": {
    bucket: "chat+terminal",
    note: "pure sync; chat seam added 2026-07-21",
  },
  "claim-grounding-verifier.ts": {
    bucket: "chat+terminal",
    note: "verifyClaimGrounding chat-wired since 2026-05-20; verifyActionAndLiveReadClaims chat seam added 2026-07-21",
  },
  "engineer-unverified-claim-verifier.ts": {
    bucket: "chat+terminal",
    note: "chat seam hand-wired 2026-07-05",
  },
  "receipt-verifier.ts": {
    bucket: "chat+terminal",
    note: "verifyDeferredPromise chat seam hand-wired 2026-07-02",
  },
  "ticket-status-grounding-verifier.ts": {
    bucket: "chat+terminal",
    note: "wired via chat-dispatcher + generic-dispatcher + autonomous-grounding",
  },

  "negative-existence-grounding-verifier.ts": {
    bucket: "chat+terminal",
    note: "verifyNegativeExistence (code-symbol class) chat+terminal wired 2026-07-29 (F4) with a hard timeout + per-tenant cache — the two prerequisites this note called out. verifyConnectorAbsence (connector-lie class, same file) is still terminal-only; its chat-seam wiring is a separate follow-up.",
  },
  "entity-traction-grounding-verifier.ts": {
    bucket: "terminal-only",
    note: "DEFERRED: async mode resolution, defaults OFF, and merges with the C8 banner. Revisit before the flag is enabled for any tenant.",
  },
  "external-artifact-claim-verifier.ts": {
    bucket: "terminal-only",
    note: "DEFERRED: defaults to warn/off. Revisit before the flag is enabled for any tenant.",
  },

  "plan-grounding-verifier.ts": {
    bucket: "delivery-only",
    note: "armed only when deliver_pdf executes; not on the reply path",
  },

  "lens-citation-verifier.ts": {
    bucket: "eval-only",
    note: "advisory; empty agent allowlist, never mutates customer text",
  },
};

const AGENTS_DIR = join(__dirname, "..");

function verifierFilesOnDisk(): string[] {
  return readdirSync(AGENTS_DIR)
    .filter((f) => f.endsWith("-verifier.ts"))
    .sort();
}

describe("verifier coverage inventory", () => {
  it("every *-verifier.ts on disk is classified", () => {
    const unclassified = verifierFilesOnDisk().filter((f) => !CLASSIFICATION[f]);

    expect(
      unclassified,
      `Unclassified verifier(s): ${unclassified.join(", ")}.\n` +
        "A new verifier must declare WHERE it runs. Add it to CLASSIFICATION in " +
        "this file.\n" +
        "  chat+terminal  — wire it into chat-text-verifiers.ts AND the runner band.\n" +
        "  terminal-only  — runner band only; say WHY it cannot run on web chat.\n" +
        "  delivery-only  — report/delivery seam.\n" +
        "  eval-only      — scoring/observability; never mutates customer text.\n" +
        "Wiring a verifier into the runner band ALONE means it does nothing on web " +
        "chat — that seam runs after the bubble has already persisted.",
    ).toEqual([]);
  });

  it("no classification entry refers to a deleted file", () => {
    const onDisk = new Set(verifierFilesOnDisk());
    const stale = Object.keys(CLASSIFICATION).filter((f) => !onDisk.has(f));

    expect(stale, `Stale classification entr(ies): ${stale.join(", ")}`).toEqual([]);
  });

  it("every terminal-only entry documents why it is not on the chat seam", () => {
    const undocumented = Object.entries(CLASSIFICATION)
      .filter(([, v]) => v.bucket === "terminal-only")
      .filter(([, v]) => !/DEFERRED:/.test(v.note))
      .map(([f]) => f);

    expect(
      undocumented,
      "A terminal-only verifier is invisible on web chat. Say why, prefixed DEFERRED:.",
    ).toEqual([]);
  });
});
