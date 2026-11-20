import { describe, it, expect } from "vitest";
import {
  PRODUCT_BUILDER_DB_SCHEMA_BASELINE,
  PRODUCT_BUILDER_SESSION_UID_RULE,
} from "@/services/agents/generic-dispatcher";

describe("product-builder DB-schema migration baseline (FIX #4)", () => {
  const b = PRODUCT_BUILDER_DB_SCHEMA_BASELINE;

  it("mandates the single deploy-time prestart path and forbids request-time DDL", () => {
    expect(b).toMatch(/prestart/);
    expect(b).toMatch(/scripts\/migrate\.mjs/);
    expect(b).toMatch(/Single deploy-time path/i);
    expect(b).toMatch(/Request handlers run only SELECT\/INSERT\/UPDATE\/DELETE/i);
    expect(b).toMatch(/Never run CREATE\/ALTER\/DROP from a request/i);
    expect(b).toMatch(/ensureSchema/i);
  });

  it("requires an immutable checksummed append-only ledger", () => {
    expect(b).toMatch(/append-only/i);
    expect(b).toMatch(/_schema_migrations/);
    expect(b).toMatch(/checksum TEXT NOT NULL/i);
    expect(b).toMatch(/SHA-256/i);
    expect(b).toMatch(/never delete, reorder, rename, or edit/i);
  });

  it("is atomic, concurrency-safe, and fails without serving partial schema", () => {
    expect(b).toMatch(/pg_advisory_xact_lock/);
    expect(b).toMatch(/SAME transaction/i);
    expect(b).toMatch(/Roll back/i);
    expect(b).toMatch(/exit non-zero/i);
    expect(b).toMatch(/FAIL LOUDLY/i);
  });

  it("does not teach disabling TLS verification in generated apps", () => {
    expect(b).not.toMatch(/rejectUnauthorized:\s*false/);
  });

  it("preserves customer rows through additive/backfilled schema evolution", () => {
    expect(b).toMatch(/backfill existing rows/i);
    expect(b).toMatch(/DROP TABLE.*FORBIDDEN/i);
    expect(b).toMatch(/TRUNCATE.*FORBIDDEN/i);
    expect(b).toMatch(/DROP COLUMN.*FORBIDDEN/i);
    expect(b).toMatch(/DELETE FROM.*FORBIDDEN/i);
    expect(b).toMatch(/CASCADE.*FORBIDDEN/i);
    expect(b).toMatch(/RENAME COLUMN/i);
    expect(b).toMatch(/USING expression/i);
  });

  it("keeps FK order/types and the complete current schema", () => {
    expect(b).toMatch(/referenced tables before referencing tables/i);
    expect(b).toMatch(/types must exactly match/i);
    expect(b).toMatch(/cumulative append-only migrations/i);
    expect(b).toMatch(/every table\/column\/index/i);
  });

  it("bounds connection retry and fails fast on non-transient DDL", () => {
    expect(b).toMatch(/up to 10 attempts/i);
    expect(b).toMatch(/capped backoff/i);
    expect(b).toMatch(/not transient and must fail immediately/i);
  });
});

describe("product-builder session uid type rule (FIX #4 secondary)", () => {
  const u = PRODUCT_BUILDER_SESSION_UID_RULE;

  it("pins the session uid to a consistent type end-to-end (cookie ↔ session ↔ query)", () => {
    expect(u).toMatch(/uid/i);
    expect(u).toMatch(/string-vs-number|string vs number/i);
    expect(u).toMatch(/cookie/i);
    expect(u).toMatch(/consistent/i);
  });

  it("(a) mandates a pg int8 / OID-20 type-parser to Number in the db lib", () => {
    expect(u).toMatch(/node-postgres/i);
    expect(u).toMatch(/OID 20/);
    expect(u).toMatch(/int8/);
    expect(u).toMatch(/setTypeParser\(20/);
    expect(u).toMatch(/Number\(v\)/);
    expect(u).toMatch(/BIGINT|BIGSERIAL/);
    expect(u).toMatch(/2\^53/);
  });

  it("(b) mandates a COERCE-not-hard-reject uid verify (no `typeof === number` reject)", () => {
    expect(u).toMatch(/Number\(parsed\.uid\)/);
    expect(u).toMatch(/Number\.isInteger/);
    expect(u).toMatch(/coerce/i);
    expect(u).toMatch(
      /NEVER write `if \(typeof parsed\.uid !== "number"\) return null`|typeof === "number" hard-reject/,
    );
    expect(u).toMatch(/NEVER|never/);
  });

  it("mandates BOTH the type-parser AND the coerce verify (belt-and-suspenders, cannot drift)", () => {
    expect(u).toMatch(/BOTH/);
    expect(u).toMatch(/makeToken/);
    expect(u).toMatch(/canonical/i);
  });
});
