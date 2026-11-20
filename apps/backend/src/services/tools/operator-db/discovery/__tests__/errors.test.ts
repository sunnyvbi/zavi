import { describe, it, expect } from "vitest";
import { sanitizeDiscoveryError } from "../errors";

describe("sanitizeDiscoveryError", () => {
  it("strips a postgres connection string with password", () => {
    const e = new Error(
      'could not connect to postgres://app:S3cretP@ss@db.acme.com:5432/prod?sslmode=require',
    );
    const out = sanitizeDiscoveryError(e);
    expect(out).not.toContain("S3cretP@ss");
    expect(out).not.toContain("db.acme.com");
    expect(out).not.toContain("app:");
    expect(out).toContain("‹conn›");
  });

  it("strips mongodb+srv and mysql URIs", () => {
    expect(
      sanitizeDiscoveryError(new Error("mongodb+srv://u:p@cluster0.x.mongodb.net/db failed")),
    ).not.toContain("cluster0.x.mongodb.net");
    expect(
      sanitizeDiscoveryError(new Error("mysql://root:toor@10.0.0.5:3306/shop timeout")),
    ).not.toContain("toor");
  });

  it("strips keyword/ADO-style DSN forms", () => {
    const out = sanitizeDiscoveryError(
      new Error("Host=db.acme.com;Username=svc;Password=S3cret;Database=prod refused"),
    );
    expect(out).not.toContain("S3cret");
    expect(out).not.toContain("db.acme.com");
    expect(out).not.toContain("svc");
    expect(out).toContain("refused");
    const out2 = sanitizeDiscoveryError(new Error("Server=db;User Id=svc;Pwd=S3cret;"));
    expect(out2).not.toContain("S3cret");
  });

  it("sanitizes an Anthropic-style error object", () => {
    const out = sanitizeDiscoveryError({
      message: "401 from api; key sk-ant-abc123DEF456ghi789 rejected",
    });
    expect(out).not.toContain("sk-ant-abc123DEF456ghi789");
  });

  it("sanitizes a Supabase RPC error shape", () => {
    const out = sanitizeDiscoveryError({
      code: "P0001",
      message: "set_tenant_db_catalog failed: postgres://svc:pw@h/db",
    });
    expect(out).not.toContain("pw@h");
    expect(out).toContain("P0001");
  });

  it("never throws on weird inputs", () => {
    expect(typeof sanitizeDiscoveryError(null)).toBe("string");
    expect(typeof sanitizeDiscoveryError(undefined)).toBe("string");
    expect(typeof sanitizeDiscoveryError("plain string with user:pw@host")).toBe("string");
    expect(sanitizeDiscoveryError("plain string with user:pw@host")).not.toContain("pw@host");
  });

  it("keeps a useful non-sensitive message", () => {
    expect(sanitizeDiscoveryError(new Error("connection timed out after 25000ms"))).toContain(
      "timed out",
    );
  });
});
