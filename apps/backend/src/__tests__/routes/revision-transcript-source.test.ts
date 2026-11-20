import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(
  join(__dirname, "../../routes/approvals/revision-transcript.ts"),
  "utf8",
);
const revisionSrc = readFileSync(
  join(__dirname, "../../routes/approvals/revision.ts"),
  "utf8",
);
const indexSrc = readFileSync(join(__dirname, "../../routes/index.ts"), "utf8");

describe("revision-transcript endpoint source contract", () => {
  it("is registered as a GET route", () => {
    expect(indexSrc).toMatch(
      /app\.get\("\/api\/approvals\/:decision_id\/revision-transcript", approvalsRevisionTranscript\)/,
    );
  });

  it("re-derives tenant from auth and 404s cross-tenant (no existence oracle)", () => {
    expect(src).toMatch(/decision\.tenant_id !== auth\.tenant_id/);
    expect(src).toMatch(/decision_not_found/);
  });

  it("is INITIATOR-ONLY — filters revision rows by created_by = auth.user_id", () => {
    expect(src).toMatch(/\.eq\("created_by", auth\.user_id\)/);
  });

  it("loads ALL statuses (history survives supersede/approve) — no status filter on the rev read", () => {
    const revSelect = src.slice(src.indexOf("decision_revision_requests"));
    expect(revSelect).not.toMatch(/\.eq\("status"/);
  });

  it("anchors assistant turns by run id + sender_role (no unrelated-thread leak)", () => {
    expect(src).toMatch(/sender_role.*assistant|"assistant"/);
    expect(src).toMatch(/\.in\("agent_run_id", runIds\)/);
  });

  it("renders user turns from the RAW message column, not the wrapped thread row", () => {
    expect(src).toMatch(/role: "user", body: r\.message/);
  });

  it("degrades to an empty transcript on assembly failure (never 500s the panel)", () => {
    expect(src).toMatch(/transcript_error: true/);
    expect(src).toMatch(/catch \(e\)/);
  });

  it("does not approve/reject or execute a Meta change (read-only)", () => {
    expect(src).not.toMatch(/approve_decision|\.rpc\("approve|set_status|update_ad_set_budget|emit_decision/);
  });
});

describe("revision POST TOCTOU 409", () => {
  it("maps the one-active unique violation (23505) to 409 revision_in_flight", () => {
    expect(revisionSrc).toMatch(/revisionErr\?\.code === "23505"/);
    expect(revisionSrc).toMatch(/revision_in_flight/);
  });
});
