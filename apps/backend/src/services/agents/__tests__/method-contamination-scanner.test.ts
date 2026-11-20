import { describe, it, expect } from "vitest";
import { scanForTenantContamination } from "@/services/agents/eval/method-contamination-scanner";

describe("scanForTenantContamination — fail-closed tenant-string gate", () => {
  it("ACCEPTS a pure method/process block", () => {
    const block = [
      "## Method (distilled)",
      "- Diagnose the funnel with your read tools before pulling any lever.",
      "- Ground every number you state in a tool result from this run and cite the tool.",
      "- Lead with the recommendation, then list concrete next actions, then stop.",
    ].join("\n");
    const r = scanForTenantContamination(block);
    expect(r.clean).toBe(true);
    expect(r.hits).toEqual([]);
  });

  it("REJECTS a tenant UUID", () => {
    const r = scanForTenantContamination(
      "- For tenant 73db45ff-457e-4541-bc8f-bdb625390204 always start with the funnel.",
    );
    expect(r.clean).toBe(false);
    expect(r.hits.some((h) => h.kind === "uuid")).toBe(true);
  });

  it("REJECTS a $-denominated figure (tenant cap/spend)", () => {
    const r = scanForTenantContamination(
      "- Keep weekly spend under the $500 standing cap.",
    );
    expect(r.clean).toBe(false);
    expect(r.hits.some((h) => h.kind === "dollar")).toBe(true);
  });

  it("REJECTS a connector-derived metric value (percent / multiplier)", () => {
    const r1 = scanForTenantContamination("- Push for a 47% ROAS uplift.");
    expect(r1.clean).toBe(false);
    expect(r1.hits.some((h) => h.kind === "percent")).toBe(true);

    const r2 = scanForTenantContamination("- Target 3.2x return on the top adset.");
    expect(r2.clean).toBe(false);
    expect(r2.hits.some((h) => h.kind === "percent")).toBe(true);
  });

  it("REJECTS a connector ref (Meta ad account / GA4 / Stripe ids)", () => {
    expect(
      scanForTenantContamination("- Use ad account act_1029384756.").clean,
    ).toBe(false);
    expect(
      scanForTenantContamination("- Read GA4 property G-ABC123XYZ.").clean,
    ).toBe(false);
    expect(
      scanForTenantContamination("- The dispute du_1MxAbC pays out.").clean,
    ).toBe(false);
  });

  it("REJECTS a concrete URL and an email (PII)", () => {
    expect(
      scanForTenantContamination("- See https://upcar.ai/dashboard.").clean,
    ).toBe(false);
    expect(
      scanForTenantContamination("- Email reethika@upcar.ai for sign-off.")
        .clean,
    ).toBe(false);
  });

  it("REJECTS a social @handle", () => {
    const r = scanForTenantContamination("- Post from @upcarofficial nightly.");
    expect(r.clean).toBe(false);
    expect(r.hits.some((h) => h.kind === "handle")).toBe(true);
  });

  it("REJECTS a caller-supplied tenant identity token even if it looks innocuous", () => {
    const block = "- Frame everything around the UpcarAI growth motion.";
    const r = scanForTenantContamination(block, {
      tenantTokens: ["UpcarAI", "upcar-ai"],
    });
    expect(r.clean).toBe(false);
    expect(r.hits.some((h) => h.kind === "tenant_token")).toBe(true);
  });

  it("does not match a too-short tenant token (avoids false positives)", () => {
    const block = "- Be concise and act decisively.";
    const r = scanForTenantContamination(block, { tenantTokens: ["AI", "a"] });
    expect(r.clean).toBe(true);
  });

  it("returns every offending span sorted by index", () => {
    const block =
      "- Cap is $500 and target 47% with act_999 on https://x.io now.";
    const r = scanForTenantContamination(block);
    expect(r.clean).toBe(false);
    expect(r.hits.length).toBeGreaterThanOrEqual(4);
    const indices = r.hits.map((h) => h.index);
    expect([...indices].sort((a, b) => a - b)).toEqual(indices);
  });
});
