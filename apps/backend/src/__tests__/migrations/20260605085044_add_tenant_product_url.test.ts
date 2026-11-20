
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
  "supabase",
  "migrations",
);
const MIGRATION_PATH = join(
  MIGRATIONS_DIR,
  "20260605085044_add_tenant_product_url.sql",
);

const sql = readFileSync(MIGRATION_PATH, "utf8");

describe(
  "add_tenant_product_url migration",
  () => {
    it("adds the tenants.product_url jsonb column", () => {
      expect(sql).toMatch(/alter table tenants\s+add column if not exists product_url jsonb/);
    });

    it("constrains product_url to a JSON object (or null)", () => {
      expect(sql).toMatch(/tenants_product_url_object_chk/);
      expect(sql).toMatch(/jsonb_typeof\(product_url\)\s*=\s*'object'/);
    });

    it("set_tenant_product_url is security-definer with a pinned search_path", () => {
      expect(sql).toMatch(
        /create or replace function set_tenant_product_url[\s\S]*?security definer set search_path = public/,
      );
    });

    it("asserts tenant-admin (admin-only write)", () => {
      expect(sql).toMatch(/perform _assert_tenant_admin\(p_tenant_id\)/);
    });

    it("enforces https-only at set-time", () => {
      expect(sql).toMatch(/must be an https:\/\/ URL/);
      expect(sql).toMatch(/v_val\s*!~\s*'\^https:\/\/'/);
    });

    it("rejects literal private/loopback/IMDS hosts at set-time", () => {
      expect(sql).toMatch(/169\.254\.169\.254/);
      expect(sql).toMatch(/private\/loopback host/);
      expect(sql).toMatch(/v_host\s*=\s*'localhost'/);
    });

    it("only allows marketing/api keys (rejects unknown keys)", () => {
      expect(sql).toMatch(/only marketing\/api allowed/);
    });

    it("writes a tenant_config_audit row", () => {
      expect(sql).toMatch(/insert into tenant_config_audit/);
      expect(sql).toMatch(/'tenant\.product_url'/);
    });

    it("revokes public + grants authenticated only", () => {
      expect(sql).toMatch(
        /revoke all on function set_tenant_product_url\(uuid, jsonb\) from public/,
      );
      expect(sql).toMatch(
        /grant execute on function set_tenant_product_url\(uuid, jsonb\) to authenticated/,
      );
    });

    it("does NOT grant the write to anon (admin-only)", () => {
      expect(sql).not.toMatch(/grant execute on function set_tenant_product_url[\s\S]*?to anon/);
    });

    it("strips userinfo via the LAST '@' (FIX 2 — not split_part on the first @)", () => {
      expect(sql).not.toMatch(/split_part\(\s*v_host\s*,\s*'@'\s*,\s*1\s*\)/);
      expect(sql).toMatch(/regexp_replace\(\s*v_host\s*,\s*'\^\.\*@'/);
    });

    it("strips surrounding brackets off IPv6 literals (FIX 4)", () => {
      expect(sql).toMatch(/v_host ~ '\^\\\['/);
      expect(sql).toMatch(/regexp_replace\(\s*v_host\s*,\s*'\^\\\[\(\[\^\\\]\]\*\)\\\]/);
      expect(sql).toMatch(/v_host = '::1'/);
      expect(sql).toMatch(/\^fe\[89ab\]/);
      expect(sql).toMatch(/\^f\[cd\]\[0-9a-f\]\{2\}:/);
    });
  },
);

function isSetTimeRejected(rawUrl: string): boolean {
  if (!/^https:\/\//.test(rawUrl)) return true;
  if (rawUrl.length > 2048) return true;

  let host = rawUrl.replace(/^https:\/\//, "").toLowerCase();
  host = host.split("/")[0];
  host = host.split("?")[0].split("#")[0];

  if (host.includes("@")) host = host.replace(/^.*@/, "");

  if (host.startsWith("[")) {
    host = host.replace(/^\[([^\]]*)\].*$/, "$1");
  } else {
    host = host.split(":")[0];
  }

  if (host === "") return true;

  return (
    host === "localhost" ||
    host.startsWith("127.") ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    host.startsWith("169.254.") ||
    host === "169.254.169.254" ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host) ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host === "::" ||
    host === "0:0:0:0:0:0:0:1" ||
    host === "0:0:0:0:0:0:0:0" ||
    /^f[cd][0-9a-f]{2}:/.test(host) ||
    /^fe[89ab][0-9a-f]:/.test(host)
  );
}

describe("set_tenant_product_url host validation — behavioral port (FIX 2 + FIX 4)", () => {
  it("FIX 2 — rejects userinfo masking a private/IMDS host", () => {
    expect(isSetTimeRejected("https://foo@169.254.169.254/")).toBe(true);
    expect(isSetTimeRejected("https://user:pass@127.0.0.1/")).toBe(true);
    expect(isSetTimeRejected("https://a@b@10.0.0.5/path")).toBe(true);
  });

  it("FIX 4 — rejects bracketed private/loopback IPv6", () => {
    expect(isSetTimeRejected("https://[::1]/")).toBe(true);
    expect(isSetTimeRejected("https://[::1]:8080/x")).toBe(true);
    expect(isSetTimeRejected("https://[fc00::1]/")).toBe(true);
    expect(isSetTimeRejected("https://[fe80::1]/")).toBe(true);
    expect(isSetTimeRejected("https://[::]/")).toBe(true);
  });

  it("still rejects the literal private/IMDS hosts the original guard caught", () => {
    expect(isSetTimeRejected("https://localhost/")).toBe(true);
    expect(isSetTimeRejected("https://169.254.169.254/latest/meta-data/")).toBe(true);
    expect(isSetTimeRejected("https://10.1.2.3/")).toBe(true);
    expect(isSetTimeRejected("https://192.168.0.1/")).toBe(true);
    expect(isSetTimeRejected("https://172.16.0.1/")).toBe(true);
  });

  it("rejects non-https + over-length", () => {
    expect(isSetTimeRejected("http://example.com/")).toBe(true);
    expect(isSetTimeRejected("https://" + "a".repeat(2100) + ".com/")).toBe(true);
  });

  it("ACCEPTS a normal public product URL (no false positive)", () => {
    expect(isSetTimeRejected("https://apnatutor.live/")).toBe(false);
    expect(isSetTimeRejected("https://api.apnatutor.live/")).toBe(false);
    expect(isSetTimeRejected("https://www.zaviagent.com/pricing?x=1")).toBe(false);
    expect(isSetTimeRejected("https://example.com:8443/app")).toBe(false);
  });
});
