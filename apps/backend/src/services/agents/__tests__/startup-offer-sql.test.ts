
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SQL = readFileSync(
  join(__dirname, "../../../../../../supabase/migrations/20260904220000_startup_offer_seats.sql"),
  "utf8",
);

const fn = (name: string): string => {
  const start = SQL.indexOf(`create or replace function ${name}(`);
  expect(start, `function ${name} not found in migration`).toBeGreaterThan(-1);
  const end = SQL.indexOf("end $$;", start);
  const alt = SQL.indexOf("$$;", start);
  return SQL.slice(start, end > -1 ? end : alt);
};

describe("startup_offer migration invariants", () => {
  it("INV-1: capacity counts paid/granted FOREVER, not just unexpired rows", () => {
    const body = fn("claim_startup_seat");
    expect(body).toMatch(/state in \('paid','granted'\)/);
    expect(body).toMatch(/state = 'pending' and expires_at > now\(\)/);
    const expireStmt = body.slice(body.indexOf("set state = 'expired'"));
    expect(expireStmt).toMatch(/state = 'pending'/);
  });

  it("INV-2: the offer row is locked FOR UPDATE before capacity is counted", () => {
    const body = fn("claim_startup_seat");
    const lockAt = body.indexOf("for update");
    const countAt = body.indexOf("select count(*) into v_used");
    expect(lockAt, "no FOR UPDATE on the offer row").toBeGreaterThan(-1);
    expect(countAt).toBeGreaterThan(-1);
    expect(lockAt).toBeLessThan(countAt);
  });

  it("INV-3: the grant door refuses a refunded (tombstoned) claim", () => {
    const body = fn("settle_startup_claim");
    expect(body).toMatch(/state = 'refunded'/);
    expect(body).toMatch(/refused_refunded/);
  });

  it("INV-4: refund tombstones BEFORE it revokes, and tolerates a missing grant", () => {
    const body = fn("tombstone_startup_claim");
    const tombstoneAt = body.indexOf("set state = 'refunded'");
    const revokeAt = body.indexOf("revoke_promo_credits");
    expect(tombstoneAt).toBeGreaterThan(-1);
    expect(revokeAt).toBeGreaterThan(-1);
    expect(tombstoneAt).toBeLessThan(revokeAt);
    expect(body).toMatch(/tombstoned_no_grant/);
  });

  it("INV-5: partial unique indexes exclude terminal states (no permanent lockout)", () => {
    expect(SQL).toMatch(
      /startup_offer_claim_user_live_uq[\s\S]*?where state in \('pending','paid','granted'\)/,
    );
    expect(SQL).toMatch(
      /startup_offer_claim_tenant_live_uq[\s\S]*?where state in \('pending','paid','granted'\)/,
    );
  });

  it("INV-6: every security-definer function pins search_path INCLUDING pg_temp", () => {
    const definers = SQL.match(/security definer[^;]*?as \$\$/g) ?? [];
    expect(definers.length).toBeGreaterThan(0);
    for (const d of definers) {
      expect(d, `search_path missing pg_temp in: ${d.slice(0, 90)}`).toMatch(
        /set search_path = public, pg_temp/,
      );
    }
  });

  it("INV-7: write RPCs are revoked from public/anon/authenticated", () => {
    for (const f of [
      "claim_startup_seat",
      "attach_startup_claim_payment",
      "settle_startup_claim",
      "tombstone_startup_claim",
    ]) {
      expect(SQL, `${f} not revoked from public roles`).toMatch(
        new RegExp(`revoke all on function ${f}\\([^)]*\\)\\s*from public, anon, authenticated;`),
      );
    }
    expect(SQL).toMatch(/grant execute on function startup_offer_status\(text\) to anon, authenticated, service_role;/);
  });

  it("INV-8: granted credits per redemption cannot exceed the grant_promo_credits cap", () => {
    expect(SQL).toMatch(/credits\s+int\s+not null check \(credits > 0 and credits <= 100000\)/);
  });
});
