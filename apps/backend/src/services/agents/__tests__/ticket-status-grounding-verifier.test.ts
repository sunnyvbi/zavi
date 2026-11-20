
import { describe, it, expect } from "vitest";
import {
  detectStatusClaim,
  selectProbeInputs,
  verifyStatusRealityGrounding,
  type ShipEvidence,
} from "../ticket-status-grounding-verifier";

function del265Evidence(overrides: Partial<ShipEvidence> = {}): ShipEvidence {
  return {
    shipping_commits: [
      {
        sha: "7633339babc1234",
        repo: "rravi149/OraiCar",
        key: "DEL-265",
        date: "2026-07-10T00:00:00Z",
        msg: "DEL-265 show top cars on empty search results",
      },
    ],
    contract_snippet:
      "export function getTopCars() { /* returns fallback cars in data */ }",
    contract_path: "src/api/carsController.ts",
    repo_scope_ok: true,
    incomplete: false,
    ...overrides,
  };
}

describe("detectStatusClaim (pure)", () => {
  it("fires on a pending assertion WITH a ticket-key anchor", () => {
    const d = detectStatusClaim(
      "DEL-286 is still pending. The iOS show-top-cars work is not done yet.",
    );
    expect(d.isPending).toBe(true);
    expect(d.anchors.ticketKeys).toContain("DEL-286");
  });

  it("extracts a code symbol anchor from backticks", () => {
    const d = detectStatusClaim(
      "Still open: `getTopCars` needs to be implemented on the backend.",
    );
    expect(d.isPending).toBe(true);
    expect(d.anchors.symbols).toContain("getTopCars");
  });

  it("extracts a file-path anchor", () => {
    const d = detectStatusClaim(
      "This is still not done - carsController.ts has not been wired up.",
    );
    expect(d.isPending).toBe(true);
    expect(d.anchors.filePaths).toContain("carsController.ts");
  });

  it("NO-OP when there is a pending phrase but NO anchor (case 7 guard)", () => {
    const d = detectStatusClaim("We are still working on it, more soon.");
    expect(d.isPending).toBe(false);
  });

  it("NO-OP when a ticket is mentioned but the text is not a status claim (false-positive guard, case 7)", () => {
    const d = detectStatusClaim(
      "Our new marketing campaign references DEL-286 in the launch copy.",
    );
    expect(d.isPending).toBe(false);
  });

  it("does not treat a prose backtick span as a symbol", () => {
    const d = detectStatusClaim("This is still pending `some plain words here`.");
    expect(d.anchors.symbols).toHaveLength(0);
    expect(d.isPending).toBe(false);
  });

  it("multi-ticket: binds the pending anchor to the NEAREST pending token, not the first key", () => {
    const d = detectStatusClaim(
      "DEL-265 shipped last month. DEL-286 is still pending, needs the wiring.",
    );
    expect(d.isPending).toBe(true);
    expect(d.anchors.ticketKeys).toEqual(
      expect.arrayContaining(["DEL-265", "DEL-286"]),
    );
    expect(d.pendingAnchors.ticketKeys[0]).toBe("DEL-286");
  });

  it("multi-ticket falsifier: a shipped-only ticket far from the pending token does NOT bind", () => {
    const pad = "x".repeat(400);
    const d = detectStatusClaim(
      `DEL-265 shipped and is fully live. ${pad} Separately, DEL-286 is still pending.`,
    );
    expect(d.pendingAnchors.ticketKeys).toEqual(["DEL-286"]);
    expect(d.anchors.ticketKeys).toEqual(
      expect.arrayContaining(["DEL-265", "DEL-286"]),
    );
  });

  it("binds a ticket key on the line ABOVE the pending word (adjacent-line status blocks)", () => {
    const d = detectStatusClaim(
      "DEL-286: iOS show top cars when empty\nJira status: In Dev. Assigned to Jignesh.",
    );
    expect(d.isPending).toBe(true);
    expect(d.pendingAnchors.ticketKeys).toContain("DEL-286");
  });

  it("suppresses (NO-OP) when the pending phrase has no anchor within the bind window", () => {
    const pad = "y".repeat(400);
    const d = detectStatusClaim(
      `DEL-265 is done and shipped. ${pad} There is still work left to do here.`,
    );
    expect(d.pendingAnchors.ticketKeys).toHaveLength(0);
    expect(d.isPending).toBe(false);
  });
});

describe("selectProbeInputs (pure)", () => {
  it("single-subject: falls back to a global file anchor so CORRECT stays reachable", () => {
    const t = "DEL-286: show top cars\nStatus: In Dev\n- wire `carsController.ts`";
    const p = selectProbeInputs(detectStatusClaim(t), t);
    expect(p.ticketKey).toBe("DEL-286");
    expect(p.filePath).toBe("carsController.ts");
  });

  it("FALSIFIER (codex P2): multi-ticket does NOT attach the shipped ticket's file to the pending probe", () => {
    const t = "DEL-265 shipped in `apps/a.ts`. DEL-286 is still pending.";
    const p = selectProbeInputs(detectStatusClaim(t), t);
    expect(p.ticketKey).toBe("DEL-286");
    expect(p.filePath).toBeUndefined();
  });

  it("multi-ticket: a file cited IN the pending ticket's own sentence IS used", () => {
    const t = "DEL-265 shipped. DEL-286 is still pending, `apps/b.ts` is unwired";
    const p = selectProbeInputs(detectStatusClaim(t), t);
    expect(p.ticketKey).toBe("DEL-286");
    expect(p.filePath).toBe("apps/b.ts");
  });
});

describe("verifyStatusRealityGrounding (pure)", () => {
  const pendingText =
    "DEL-286 is still pending. We still need to build the iOS `getTopCars` empty-search fallback in carsController.ts. Here is a 5-task plan...";

  it("CASE 1 — DEL-286 incident replay: pending text + DEL-265 commit + contract → CORRECT", () => {
    const r = verifyStatusRealityGrounding(pendingText, del265Evidence());
    expect(r.tier).toBe("CORRECT");
    expect(r.banner).toBeTruthy();
    expect(r.banner).toMatch(/already shipped/i);
    expect(r.banner).toContain("7633339");
    expect(r.banner).toContain("DEL-265");
  });

  it("CASE 2 — shipped under a different key is surfaced via the commit's own key", () => {
    const r = verifyStatusRealityGrounding(pendingText, del265Evidence());
    expect(r.banner).toContain("DEL-265");
    expect(r.banner).not.toContain("DEL-286");
  });

  it("CASE 3 — correction is NOT destructive: the ORIGINAL text is preserved by the caller (banner is additive)", () => {
    const r = verifyStatusRealityGrounding(pendingText, del265Evidence());
    const finalText = `> ${r.banner}\n\n${pendingText}`;
    expect(finalText).toContain(pendingText);
    expect(finalText.indexOf(r.banner!)).toBeLessThan(finalText.indexOf(pendingText));
  });

  it("CASE 6 — genuinely pending (no commit, clean probe) → NOOP, status returned unchanged", () => {
    const empty: ShipEvidence = {
      shipping_commits: [],
      contract_snippet: null,
      contract_path: null,
      repo_scope_ok: true,
      incomplete: false,
    };
    const r = verifyStatusRealityGrounding(pendingText, empty);
    expect(r.tier).toBe("NOOP");
    expect(r.banner).toBeNull();
  });

  it("HEDGE — a commit found but NO contract match", () => {
    const r = verifyStatusRealityGrounding(
      pendingText,
      del265Evidence({ contract_snippet: null, contract_path: null }),
    );
    expect(r.tier).toBe("HEDGE");
    expect(r.banner).toMatch(/may already be shipped/i);
    expect(r.banner).toMatch(/verify/i);
  });

  it("HEDGE (finding 4) — commit + snippet but from a NON-MATCHING path stays HEDGE, not CORRECT", () => {
    const r = verifyStatusRealityGrounding(
      pendingText,
      del265Evidence({ contract_path: "src/other/unrelated.ts" }),
    );
    expect(r.tier).toBe("HEDGE");
  });

  it("CORRECT (finding 4) — path match is suffix-tolerant (bare filename anchor vs repo-relative path)", () => {
    const r = verifyStatusRealityGrounding(
      pendingText,
      del265Evidence({ contract_path: "src/api/carsController.ts" }),
    );
    expect(r.tier).toBe("CORRECT");
  });

  it("HEDGE — incomplete probe (rate-limited) with no commit yet", () => {
    const r = verifyStatusRealityGrounding(pendingText, {
      shipping_commits: [],
      contract_snippet: null,
      contract_path: null,
      repo_scope_ok: true,
      incomplete: true,
    });
    expect(r.tier).toBe("HEDGE");
    expect(r.banner).toMatch(/could not be completed/i);
  });

  it("HEDGE — connector exists but repo scope could not be confirmed (repo_scope_ok false, incomplete)", () => {
    const r = verifyStatusRealityGrounding(pendingText, {
      shipping_commits: [],
      contract_snippet: null,
      contract_path: null,
      repo_scope_ok: false,
      incomplete: true,
    });
    expect(r.tier).toBe("HEDGE");
  });

  it("NOOP — null evidence (probe not run / connector absent)", () => {
    expect(verifyStatusRealityGrounding(pendingText, null).tier).toBe("NOOP");
  });

  it("NOOP — non-status text even with a real shipping commit (false-positive guard)", () => {
    const marketing =
      "Our launch deck references DEL-286 and the `getTopCars` feature as a win.";
    const r = verifyStatusRealityGrounding(marketing, del265Evidence());
    expect(r.tier).toBe("NOOP");
    expect(r.banner).toBeNull();
  });

  it("NOOP — pending phrase but no anchor, even with evidence present", () => {
    const r = verifyStatusRealityGrounding(
      "This is still pending, more soon.",
      del265Evidence(),
    );
    expect(r.tier).toBe("NOOP");
  });

  it("staleness — a shipped-under-another-key commit dated AFTER the ticket still corrects (date carried through)", () => {
    const r = verifyStatusRealityGrounding(
      pendingText,
      del265Evidence({
        shipping_commits: [
          {
            sha: "abcdef1234567",
            repo: "rravi149/upcar",
            key: "DEL-265",
            date: "2026-07-16T00:00:00Z",
            msg: "DEL-265 backend fallback cars",
          },
        ],
      }),
    );
    expect(r.tier).toBe("CORRECT");
    expect(r.banner).toContain("abcdef1");
  });
});
