import { describe, it, expect } from "vitest";
import {
  buildProjection,
  buildAggregatePipeline,
  SECRET_FIELD_RE,
} from "../drivers/mongo";

describe("mongo driver · buildAggregatePipeline (P1 — final hard $limit always appended)", () => {
  it("appends a final $limit within the gateway ceiling when the pipeline has none", () => {
    const out = buildAggregatePipeline([{ $match: { x: 1 } }], 5000, undefined);
    expect(out[out.length - 1]).toEqual({ $limit: 5000 });
  });

  it("appends a FINAL hard $limit even when the pipeline already has an earlier $limit", () => {
    const out = buildAggregatePipeline(
      [{ $match: { x: 1 } }, { $limit: 100 }],
      5000,
      undefined,
    );
    expect(out[out.length - 1]).toEqual({ $limit: 5000 });
    expect(out.some((s) => JSON.stringify(s) === JSON.stringify({ $limit: 100 }))).toBe(true);
  });

  it("places the $project before the final $limit when a projection is supplied", () => {
    const out = buildAggregatePipeline(
      [{ $match: { x: 1 } }],
      10,
      { secret_token: 0 },
    );
    expect(out[out.length - 1]).toEqual({ $limit: 11 });
    expect(out[out.length - 2]).toEqual({ $project: { secret_token: 0 } });
  });
});

describe("mongo driver · buildProjection (P2 — secret-field exclusion defense-in-depth)", () => {
  it("emits a pure exclusion projection on the NO-projection path", () => {
    const out = buildProjection(undefined, ["password_hash", "api_token"]);
    expect(out).toEqual({ password_hash: 0, api_token: 0 });
  });

  it("returns undefined when no projection AND no secret fields", () => {
    expect(buildProjection(undefined, [])).toBeUndefined();
    expect(buildProjection(undefined, undefined)).toBeUndefined();
  });

  it("ignores non-secret-named fields passed as exclusions (defensive re-check)", () => {
    expect(buildProjection(undefined, ["city", "status"])).toBeUndefined();
  });

  it("merges secret exclusions into an EXCLUSION caller projection", () => {
    const out = buildProjection({ internal_notes: 0 }, ["secret_key"]);
    expect(out).toEqual({ internal_notes: 0, secret_key: 0 });
  });

  it("strips a secret-named field the caller tried to INCLUDE (cannot mix exclusions)", () => {
    const out = buildProjection({ id: 1, name: 1, access_key: 1 }, ["access_key"]);
    expect(out).toEqual({ id: 1, name: 1 });
    expect(out && "access_key" in out).toBe(false);
  });

  it("normalizes arbitrary positive/zero projection values to 1/0", () => {
    const out = buildProjection({ a: 5, b: 0 }, undefined);
    expect(out).toEqual({ a: 1, b: 0 });
  });
});

describe("mongo driver · SECRET_FIELD_RE", () => {
  for (const f of [
    "password",
    "password_hash",
    "secret",
    "client_secret",
    "api_key",
    "apiKey",
    "private_key",
    "access_token",
    "credential",
    "body",
    "raw_body",
    "html",
    "encrypted_blob",
  ]) {
    it(`matches secret-named field "${f}"`, () => {
      expect(SECRET_FIELD_RE.test(f)).toBe(true);
    });
  }
  for (const f of ["id", "city", "status", "created_at", "amount", "category"]) {
    it(`does NOT match neutral field "${f}"`, () => {
      expect(SECRET_FIELD_RE.test(f)).toBe(false);
    });
  }
});
