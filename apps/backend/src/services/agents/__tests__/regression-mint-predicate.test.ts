import { describe, it, expect } from "vitest";
import {
  decideMintable,
  MINT_LIVE_SLUGS,
  type MintCandidateRow,
} from "../regression-mint-predicate";

const row = (over: Partial<MintCandidateRow>): MintCandidateRow => ({
  agent_slug: "engineer",
  status: "failed",
  error: null,
  last_progress_at: "2026-06-04T00:00:00Z",
  ...over,
});

describe("decideMintable", () => {
  it("mints parse_failed on ANY agent (deterministic v1 class)", () => {
    expect(decideMintable(row({ agent_slug: "support-lead", status: "parse_failed" })))
      .toEqual({ mintable: true, reason: "mint" });
  });

  it("mints a live failure on engineer / pm", () => {
    expect(decideMintable(row({ agent_slug: "engineer", status: "failed" })).mintable).toBe(true);
    expect(decideMintable(row({ agent_slug: "pm", status: "failed" })).mintable).toBe(true);
  });

  it("MINTS a live failure on a non-money agent (widened 2026-06-05)", () => {
    expect(decideMintable(row({ agent_slug: "support-lead", status: "failed" })))
      .toEqual({ mintable: true, reason: "mint" });
    expect(
      decideMintable(row({ agent_slug: "operator", status: "dispatch_error", last_progress_at: "2026-06-04T00:00:00Z" })).mintable,
    ).toBe(true);
  });

  it("excludes money-path slugs entirely (E3 firewall) — incl. after the widen", () => {
    for (const slug of ["performance-marketer", "dispute-response"]) {
      expect(decideMintable(row({ agent_slug: slug, status: "parse_failed" })))
        .toEqual({ mintable: false, reason: "money_slug_excluded" });
      expect(decideMintable(row({ agent_slug: slug, status: "failed" })))
        .toEqual({ mintable: false, reason: "money_slug_excluded" });
      expect(decideMintable(row({ agent_slug: slug, status: "dispatch_error", last_progress_at: "2026-06-04T00:00:00Z" })))
        .toEqual({ mintable: false, reason: "money_slug_excluded" });
    }
  });

  it("excludes an infra ORPHAN (infra-shaped AND no progress)", () => {
    expect(
      decideMintable(
        row({ agent_slug: "engineer", status: "dispatch_error", last_progress_at: null }),
      ),
    ).toEqual({ mintable: false, reason: "infra_orphan_excluded" });
    expect(
      decideMintable(
        row({ status: "failed", error: "boot_reap: container died", last_progress_at: null }),
      ),
    ).toEqual({ mintable: false, reason: "infra_orphan_excluded" });
  });

  it("MINTS a dispatch_error that DID emit progress (P1-B fix — not a blanket exclude)", () => {
    expect(
      decideMintable(
        row({
          agent_slug: "engineer",
          status: "dispatch_error",
          last_progress_at: "2026-06-04T00:00:00Z",
        }),
      ),
    ).toEqual({ mintable: true, reason: "mint" });
  });

  it("does NOT mint a non-failure status", () => {
    expect(decideMintable(row({ status: "success" })))
      .toEqual({ mintable: false, reason: "not_a_failure" });
    expect(decideMintable(row({ status: "running" })).mintable).toBe(false);
  });

  it("MINT_LIVE_SLUGS retained for reference but no longer gates (all non-money mint)", () => {
    expect([...MINT_LIVE_SLUGS].sort()).toEqual(["engineer", "pm"]);
    expect(decideMintable(row({ agent_slug: "research", status: "failed" })).mintable).toBe(true);
  });
});
