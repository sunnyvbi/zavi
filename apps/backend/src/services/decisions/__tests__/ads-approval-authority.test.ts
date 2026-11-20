import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  capGovernsDispatch,
  isTenantHumanApproval,
  ADS_CAP_BYPASS_CLASSES,
} from "../ads-approval-authority";
import {
  decisionVerdict,
  isHousekeepingReject,
  DECISION_STATUS_DISPATCH_FAILED,
} from "../status";

const RAVI = "0335f3eb-8f08-4f72-91e1-6cd085503f13";

describe("approval is authority — capGovernsDispatch", () => {
  it("a HUMAN-APPROVED ads decision is NOT governed by the cap (the incident)", () => {
    expect(
      capGovernsDispatch({
        decision_class: "meta_ads.create_ad_set",
        approved_by: RAVI,
        approved_by_source: null,
      }),
    ).toBe(false);
  });

  it("an AUTO-FIRED ads decision IS still governed by the cap (fails closed on a null cap)", () => {
    expect(
      capGovernsDispatch({
        decision_class: "meta_ads.create_ad_set",
        approved_by: null,
      }),
    ).toBe(true);
  });

  it("a STAFF override on an ads class is STILL governed by the cap (not tenant spend authority)", () => {
    expect(
      capGovernsDispatch({
        decision_class: "meta_ads.create_ad_set",
        approved_by: RAVI,
        approved_by_source: "staff",
      }),
    ).toBe(true);
  });

  it("a CGO approval on an ads class is STILL governed by the cap, on every ads class", () => {
    for (const cls of ADS_CAP_BYPASS_CLASSES) {
      expect(
        capGovernsDispatch({ decision_class: cls, approved_by: RAVI, approved_by_source: "cgo" }),
      ).toBe(true);
    }
  });

  it("a tenant-human approval (source null) still bypasses the ads cap", () => {
    expect(
      capGovernsDispatch({
        decision_class: "meta_ads.create_ad_set",
        approved_by: RAVI,
        approved_by_source: null,
      }),
    ).toBe(false);
  });

  it("covers every ads money class, both platforms, both budget and resume", () => {
    for (const cls of [
      "meta_ads.create_ad_set",
      "meta_ads.update_ad_set_budget",
      "meta_ads.update_ad_set_budget_review",
      "meta_ads.set_status",
      "meta_ads.set_status_review",
      "google_ads.update_campaign_budget",
      "google_ads.update_campaign_budget_review",
      "google_ads.set_status",
      "google_ads.set_status_review",
    ]) {
      expect(capGovernsDispatch({ decision_class: cls, approved_by: RAVI, approved_by_source: null })).toBe(false);
      expect(capGovernsDispatch({ decision_class: cls, approved_by: null, approved_by_source: null })).toBe(true);
    }
  });

  it("does NOT bypass for a non-ads class even when approved_by is set", () => {
    for (const cls of [
      "autopilot.daily-plan",
      "engineer.ship-pr",
      "chief-of-staff.dispatch-specialist",
      "slack.post_message",
      "meta_ads_but_not_really",
    ]) {
      expect(capGovernsDispatch({ decision_class: cls, approved_by: RAVI })).toBe(true);
    }
  });

  it("an approval from any source that is not a tenant person keeps the cap, on every ads class", () => {
    for (const source of ["plan_autopilot", "system", "founder_rules", "web", "ledger", "", "CGO", "Staff", "some_new_automation"]) {
      for (const cls of ADS_CAP_BYPASS_CLASSES) {
        expect(capGovernsDispatch({ decision_class: cls, approved_by: RAVI, approved_by_source: source }), `${source} on ${cls}`).toBe(true);
      }
      expect(isTenantHumanApproval({ approved_by: RAVI, approved_by_source: source })).toBe(false);
    }
  });

  it("a tenant person is an approver with no source, or the owner's verified email yes, nothing else", () => {
    expect(isTenantHumanApproval({ approved_by: RAVI, approved_by_source: null })).toBe(true);
    expect(isTenantHumanApproval({ approved_by: RAVI, approved_by_source: "email" })).toBe(true);
    expect(capGovernsDispatch({ decision_class: "meta_ads.update_ad_set_budget", approved_by: RAVI, approved_by_source: "email" })).toBe(false);
    expect(isTenantHumanApproval({ approved_by: null, approved_by_source: "email" })).toBe(false);
    expect(isTenantHumanApproval({ approved_by: RAVI })).toBe(false);
    expect(capGovernsDispatch({ decision_class: "meta_ads.create_ad_set", approved_by: RAVI })).toBe(true);
    expect(isTenantHumanApproval({ approved_by: "", approved_by_source: null })).toBe(false);
    expect(isTenantHumanApproval({ approved_by: null, approved_by_source: null })).toBe(false);
    expect(isTenantHumanApproval({ approved_by: RAVI, approved_by_source: "cgo" })).toBe(false);
  });

  it("fails safe on an empty-string approver (treats it as unattended)", () => {
    expect(
      capGovernsDispatch({ decision_class: "meta_ads.create_ad_set", approved_by: "" }),
    ).toBe(true);
  });

  it("GUARD: the trust-ladder never auto-approves an ads class", () => {
    const src = readFileSync(
      resolve(__dirname, "../trust-ladder.ts"),
      "utf8",
    );
    const found = [...ADS_CAP_BYPASS_CLASSES].filter((cls) => src.includes(cls));
    expect(
      found,
      "An ads decision class appears in services/decisions/trust-ladder.ts. The trust " +
        "ladder AUTO-APPROVES by stamping the tenant OWNER into approved_by with NO human " +
        "click. capGovernsDispatch() treats a set approved_by on an ads class as 'a human " +
        "authorized this spend' and SKIPS the cap — so an ads class on the ladder means " +
        "UNATTENDED, UNCAPPED ad spend. Either keep ads off the ladder, or change " +
        "capGovernsDispatch to require a real interactive approval origin (not just " +
        "approved_by). Do not delete this test to make it pass.",
    ).toEqual([]);
  });
});

describe("GUARD: automation never approves as the owner", () => {
  const BACKEND = resolve(__dirname, "../../../..");

  const HUMAN_DOORS = new Set([
    "src/routes/approvals/decide.ts",
    "src/routes/approvals/finalize-evidence.ts",
    "src/routes/webhooks/slack-interactions.ts",
    "src/services/approvals/batch-decide-service.ts",
    "src/routes/channels/actions.ts",
    "src/routes/admin/decision-execute.ts",
    "src/routes/admin/decision-decide.ts",
    "src/services/ad-locations/service.ts",
    "src/services/connectors/meta-ads/campaign-editor.ts",
    "src/services/connectors/google-ads/campaign-editor.ts",
    "src/services/growth/founder-reply-approve.ts",
    "src/services/approvals/envelope-door.ts",
    "src/services/ads-wallet/plan-funding.ts",
    "src/services/growth/ad-plan-yes.ts",
    "src/services/growth/held-order-yes.ts",
  ]);
  const AUTOMATION_NEVER_ADS = new Set([
    "src/services/decisions/trust-ladder.ts",
    "workers/functions/fundraising-run-angel-round.ts",
  ]);

  const tsFiles = (dir: string, out: string[] = []): string[] => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === "__tests__") continue;
        tsFiles(p, out);
      } else if (p.endsWith(".ts") && !p.endsWith(".d.ts") && !p.endsWith(".test.ts")) {
        out.push(p);
      }
    }
    return out;
  };
  const code = (p: string) =>
    readFileSync(p, "utf8")
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
  const callArgs = (src: string, fn: string): string[] => {
    const out: string[] = [];
    const re = new RegExp(`(?<!function\\s)\\b${fn}\\(`, "g");
    for (let m = re.exec(src); m; m = re.exec(src)) {
      let depth = 1;
      let i = m.index + m[0].length;
      const start = i;
      while (i < src.length && depth > 0) {
        if (src[i] === "(") depth++;
        else if (src[i] === ")") depth--;
        i++;
      }
      out.push(src.slice(start, i - 1));
    }
    return out;
  };

  const callers = [...tsFiles(join(BACKEND, "src")), ...tsFiles(join(BACKEND, "workers"))]
    .map((p) => ({ rel: relative(BACKEND, p), src: code(p) }))
    .map((f) => ({
      ...f,
      decide: callArgs(f.src, "decideOnDecision"),
      channel: callArgs(f.src, "approveChannelAction"),
    }))
    .filter((f) => f.decide.length + f.channel.length > 0);

  it("finds the known approval callers (the scan is not blind)", () => {
    const rels = callers.map((c) => c.rel);
    expect(rels).toContain("src/services/growth/cgo-auto-run.ts");
    expect(rels).toContain("src/services/decisions/trust-ladder.ts");
    expect(rels).toContain("src/routes/channels/actions.ts");
  });

  it("every automation approval either never touches ads or names the cgo/staff source", () => {
    const ADS_MARKERS = [...ADS_CAP_BYPASS_CLASSES, "meta_ads", "google_ads"];
    const offenders: string[] = [];
    for (const c of callers) {
      if (HUMAN_DOORS.has(c.rel)) continue;
      if (AUTOMATION_NEVER_ADS.has(c.rel)) {
        const hit = ADS_MARKERS.filter((m) => c.src.includes(m));
        if (hit.length) offenders.push(`${c.rel}: automation approving as the owner mentions ${hit.join(", ")}`);
        continue;
      }
      for (const a of c.decide) {
        if (!/approver_source:\s*"cgo"/.test(a) && !/staff_override:\s*true/.test(a)) {
          offenders.push(`${c.rel}: decideOnDecision(...) without approver_source "cgo" or staff_override`);
        }
      }
      for (const a of c.channel) {
        if (!/source:\s*"(cgo|staff)"/.test(a)) {
          offenders.push(`${c.rel}: approveChannelAction(...) without source "cgo" or "staff"`);
        }
      }
    }
    expect(
      offenders,
      "An automated code path approves as the tenant owner with no approver source. " +
        "capGovernsDispatch reads approved_by with a NULL source on an ads class as a " +
        "tenant human's spend authority and SKIPS the cap, so that path is unattended, " +
        "uncapped ad spend. Pass approver_source: \"cgo\" (decisions) or source: \"cgo\" " +
        "(channel actions). If the caller really is a person clicking, add it to " +
        "HUMAN_DOORS in review. Do not delete this test to make it pass.",
    ).toEqual([]);
  });

  it("the CGO's ad-action approval (cgo-ads) approves channel actions through the cgo source", () => {
    const c = callers.find((x) => x.rel === "src/services/growth/cgo-ads.ts");
    expect(c?.channel.length).toBeGreaterThan(0);
    for (const a of c?.channel ?? []) expect(a).toMatch(/source:\s*"cgo"/);
  });

  it("cgo-auto-run approves through the cgo source, never as the plain owner", () => {
    const c = callers.find((x) => x.rel === "src/services/growth/cgo-auto-run.ts");
    expect(c?.decide.length).toBeGreaterThan(0);
    for (const a of c?.decide ?? []) expect(a).toMatch(/approver_source:\s*"cgo"/);
  });
});

describe("dispatch failure is NOT a rejection — decisionVerdict", () => {
  it("a dispatch failure counts as NEITHER accept nor reject", () => {
    expect(
      decisionVerdict({
        status: DECISION_STATUS_DISPATCH_FAILED,
        dispatch_error: "cap_refuse: no_cap_configured",
        body: {},
      }),
    ).toBeNull();
  });

  it("a legacy 'rejected' row that carries a dispatch_error is still not a rejection", () => {
    expect(
      decisionVerdict({
        status: "rejected",
        dispatch_error: "push_to_main tree HTTP 422",
        body: {},
      }),
    ).toBeNull();
  });

  it("a REAL human rejection still counts as a rejection", () => {
    expect(
      decisionVerdict({ status: "rejected", dispatch_error: null, body: {} }),
    ).toBe("rejected");
  });

  it("PM auto-resolve housekeeping is not a founder rejection", () => {
    expect(
      decisionVerdict({
        status: "rejected",
        dispatch_error: null,
        body: { auto_resolved: true },
      }),
    ).toBeNull();
    expect(isHousekeepingReject({ dispatch_error: null, body: { auto_resolved: true } })).toBe(true);
  });

  it("'acted' is the accept signal; 'approved' is transient and counts for nothing", () => {
    expect(decisionVerdict({ status: "acted", dispatch_error: null, body: {} })).toBe("accepted");
    expect(decisionVerdict({ status: "approved", dispatch_error: null, body: {} })).toBeNull();
    expect(decisionVerdict({ status: "proposed", dispatch_error: null, body: {} })).toBeNull();
  });
});
