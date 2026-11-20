
import { describe, expect, it } from "vitest";
import { pgSslOption, sslModeOf } from "../pg-ssl";

describe("pgSslOption", () => {
  it("keeps TLS on, unverified, when the operator said nothing", () => {
    expect(pgSslOption("postgres://u:p@db.example.com:5432/app")).toEqual({
      rejectUnauthorized: false,
    });
  });

  it("obeys an explicit sslmode=disable instead of overriding it", () => {
    expect(pgSslOption("postgres://u:p@10.0.0.4:5432/app?sslmode=disable")).toBe(false);
  });

  it("treats every other sslmode as TLS-on", () => {
    for (const mode of ["require", "verify-full", "prefer", "allow"]) {
      expect(pgSslOption(`postgres://u@h/db?sslmode=${mode}`), mode).toEqual({
        rejectUnauthorized: false,
      });
    }
  });

  it("reads sslmode out of a libpq keyword/value DSN too", () => {
    expect(sslModeOf("host=10.0.0.4 dbname=app sslmode=disable")).toBe("disable");
    expect(pgSslOption("host=10.0.0.4 dbname=app sslmode=disable")).toBe(false);
  });

  it("is case-insensitive about the mode", () => {
    expect(pgSslOption("postgres://u@h/db?sslmode=DISABLE")).toBe(false);
  });

  it("does not mistake a password or dbname containing 'sslmode' for the option", () => {
    expect(sslModeOf("postgres://u@h/sslmodedb")).toBeNull();
  });

  it("ignores 'sslmode=disable' hiding inside a quoted libpq value", () => {
    const dsn = "host=db.example.com dbname=app user=zavi password='abc sslmode=disable xyz'";
    expect(sslModeOf(dsn)).toBeNull();
    expect(pgSslOption(dsn)).toEqual({ rejectUnauthorized: false });
  });

  it("still honours a real sslmode option in a libpq DSN alongside a quoted value", () => {
    const dsn = "host=10.0.0.4 dbname=app password='p@ss word' sslmode=disable";
    expect(sslModeOf(dsn)).toBe("disable");
    expect(pgSslOption(dsn)).toBe(false);
  });

  it("survives an escaped quote inside a libpq value", () => {
    const dsn = String.raw`host=h dbname=app password='it\'s sslmode=disable' sslmode=require`;
    expect(sslModeOf(dsn)).toBe("require");
    expect(pgSslOption(dsn)).toEqual({ rejectUnauthorized: false });
  });

  it("accepts whitespace around the option", () => {
    expect(sslModeOf("host=h sslmode = disable")).toBe("disable");
  });

  it("honours a legitimately QUOTED sslmode value", () => {
    expect(sslModeOf("host=h dbname=app sslmode='disable'")).toBe("disable");
    expect(pgSslOption("host=h sslmode='disable'")).toBe(false);
  });

  it("returns null rather than guessing on a malformed DSN", () => {
    expect(sslModeOf("host=h dbname=app password='never closed")).toBeNull();
    expect(sslModeOf("")).toBeNull();
    expect(sslModeOf("host=h sslmode=")).toBeNull();
    expect(pgSslOption("host=h dbname=app password='never closed")).toEqual({
      rejectUnauthorized: false,
    });
  });
});
