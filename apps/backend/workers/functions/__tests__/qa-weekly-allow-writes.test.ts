import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (rel: string): string =>
  readFileSync(join(process.cwd(), rel), "utf8");

describe("qa_weekly_allow_writes — dispatcher derivation (E3 containment)", () => {
  const src = read("src/services/agents/generic-dispatcher.ts");

  it("reads the setting server-side, gated on the trusted QA signal + staging_origin", () => {
    expect(src).toMatch(/isQaWeeklyDispatch && stagingOrigin/);
    expect(src).toMatch(/getBoolSetting\(\s*"qa_weekly_allow_writes",\s*ctx\.tenant_id,?\s*\)/);
  });

  it("fails CLOSED to read-only on a settings-read error", () => {
    expect(src).toMatch(/catch\s*\{\s*\n?\s*qaWritesAllowed = false/);
  });

  it("read_only is derived ONLY from the trusted signal + the server-read setting", () => {
    expect(src).toMatch(/const isReadOnlyDispatch = isQaWeeklyDispatch && !qaWritesAllowed/);
    expect(src).not.toMatch(/payload\.read_only\s*===\s*true/);
  });
});

describe("qa_weekly_allow_writes — worker is read-only (browser__task era)", () => {
  const src = read("workers/functions/qa-weekly-execute.ts");

  it("never reads the setting: allowWrites is a constant false", () => {
    expect(src).toMatch(/const allowWrites = false;/);
    expect(src).not.toMatch(/getBoolSetting\(\s*"qa_weekly_allow_writes"/);
  });

  it("needs-write cases are pre-blocked (the false branch)", () => {
    expect(src).toMatch(/const preblocked: PreblockedCase\[\] = allowWrites\s*\n?\s*\?\s*\[\]/);
  });

  it("each case is enqueued as a qa run on the browser-worker path", () => {
    expect(src).toMatch(/agent_slug: "qa"/);
    expect(src).toMatch(/source: QA_WEEKLY_SOURCE/);
    expect(src).not.toMatch(/agent_slug: "browser-operator"/);
  });
});

describe("qa_weekly_allow_writes — settings registry", () => {
  const src = read("src/services/settings/registry.ts");

  it("registered per-tenant, default false", () => {
    expect(src).toMatch(/qa_weekly_allow_writes:\s*\{[\s\S]{0,600}scope:\s*"per-tenant",\s*\n?\s*defaultValue:\s*false/);
  });

  it("listed as per-tenant-consent-only (no global arm)", () => {
    const consentBlock = src.slice(src.indexOf("CONSENT_KEYS_PER_TENANT_ONLY"));
    expect(consentBlock).toContain('"qa_weekly_allow_writes"');
  });
});
