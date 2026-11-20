import { describe, it, expect } from "vitest";
import { dirname, join } from "node:path";
import { hasExplicitTls, noTlsMessage, NO_TLS_MESSAGES, requireTlsByDefault, transportOf } from "../direct/tls";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ConnectionConfig = require(join(dirname(require.resolve("mysql2")), "lib/connection_config.js")) as { parseUrl(u: string): Record<string, unknown> };

describe("requireTlsByDefault (new logins)", () => {
  it("MySQL without an ssl option gets TLS (certificate not verified), as mysql2 parses it", () => {
    const out = requireTlsByDefault("mysql", "mysql://u:p%40ss@db.example.com:3306/shop");
    expect(out).toBe('mysql://u:p%40ss@db.example.com:3306/shop?ssl=%7B%22rejectUnauthorized%22%3Afalse%7D');
    expect(ConnectionConfig.parseUrl(out).ssl).toEqual({ rejectUnauthorized: false });
    expect(ConnectionConfig.parseUrl(out).password).toBe("p@ss");
    expect(transportOf("mysql", out)).toBe("unverified_tls");
  });

  it("MySQL keeps existing query options and an explicit choice", () => {
    expect(requireTlsByDefault("mysql", "mysql://u:p@h/db?charset=utf8mb4")).toBe(
      "mysql://u:p@h/db?charset=utf8mb4&ssl=%7B%22rejectUnauthorized%22%3Afalse%7D",
    );
    expect(requireTlsByDefault("mysql", "mysql://u:p@h/db?ssl=false")).toBe("mysql://u:p@h/db?ssl=false");
    expect(ConnectionConfig.parseUrl("mysql://u:p@h/db?ssl=false").ssl).toBe(false);
    const verified = 'mysql://u:p@h/db?ssl={"rejectUnauthorized":true}';
    expect(requireTlsByDefault("mysql", verified)).toBe(verified);
    expect(transportOf("mysql", verified)).toBe("verified_tls");
  });

  it("MongoDB mongodb:// gets tls=true, including multi-host strings without a path", () => {
    expect(requireTlsByDefault("mongodb", "mongodb://u:p@h1:27017,h2:27017")).toBe(
      "mongodb://u:p@h1:27017,h2:27017/?tls=true&tlsAllowInvalidCertificates=true",
    );
    expect(requireTlsByDefault("mongodb", "mongodb://u:p@h1/app?replicaSet=rs0")).toBe(
      "mongodb://u:p@h1/app?replicaSet=rs0&tls=true&tlsAllowInvalidCertificates=true",
    );
    expect(transportOf("mongodb", "mongodb://u:p@h1/app?replicaSet=rs0&tls=true&tlsAllowInvalidCertificates=true")).toBe("unverified_tls");
  });

  it("MongoDB opt-outs and srv strings are left alone", () => {
    expect(requireTlsByDefault("mongodb", "mongodb://h/app?tls=false")).toBe("mongodb://h/app?tls=false");
    expect(requireTlsByDefault("mongodb", "mongodb://h/app?ssl=false")).toBe("mongodb://h/app?ssl=false");
    expect(requireTlsByDefault("mongodb", "mongodb+srv://u:p@cluster0.x.mongodb.net/app")).toBe("mongodb+srv://u:p@cluster0.x.mongodb.net/app");
    expect(transportOf("mongodb", "mongodb+srv://u:p@cluster0.x.mongodb.net/app")).toBe("verified_tls");
  });

  it("Postgres and DynamoDB strings are unchanged", () => {
    expect(requireTlsByDefault("postgres", "postgres://u:p@h/db")).toBe("postgres://u:p@h/db");
    expect(requireTlsByDefault("dynamodb", "dynamodb://AK:SK@us-east-1")).toBe("dynamodb://AK:SK@us-east-1");
  });

  it("an option name inside the password is not an explicit choice", () => {
    expect(hasExplicitTls("mysql", "mysql://u:ssl=false@h/db")).toBe(false);
  });
});

describe("transportOf (existing logins)", () => {
  it("reports what an old string actually does", () => {
    expect(transportOf("mysql", "mysql://u:p@h/db")).toBe("plaintext");
    expect(transportOf("mongodb", "mongodb://u:p@h/db")).toBe("plaintext");
    expect(transportOf("mongodb", "mongodb://u:p@h/db?ssl=true")).toBe("verified_tls");
    expect(transportOf("mongodb", "mongodb://u:p@h/db?tls=true&sslValidate=false")).toBe("unverified_tls");
    expect(transportOf("postgres", "postgres://u:p@h/db")).toBe("unverified_tls");
    expect(transportOf("postgres", "postgres://u:p@h/db?sslmode=disable")).toBe("plaintext");
    expect(transportOf("dynamodb", "dynamodb://x")).toBeNull();
  });
});

describe("noTlsMessage", () => {
  it("names the opt-out for each database when the server will not speak TLS", () => {
    expect(noTlsMessage("postgres", new Error("The server does not support SSL connections"), "postgres://h/db")).toBe(NO_TLS_MESSAGES.postgres);
    expect(noTlsMessage("mysql", new Error("Server does not support secure connection"), "mysql://h/db?ssl=x")).toBe(NO_TLS_MESSAGES.mysql);
    const mongo = "mongodb://h/db?tls=true&tlsAllowInvalidCertificates=true";
    expect(noTlsMessage("mongodb", new Error("connection 1 to 10.0.0.5:27017 closed"), mongo)).toBe(NO_TLS_MESSAGES.mongodb);
  });
  it("leaves other failures to the normal message", () => {
    const mongo = "mongodb://h/db?tls=true";
    expect(noTlsMessage("mongodb", new Error("getaddrinfo ENOTFOUND h"), mongo)).toBeNull();
    expect(noTlsMessage("mongodb", new Error("Authentication failed."), mongo)).toBeNull();
    expect(noTlsMessage("mongodb", new Error("connection closed"), "mongodb://h/db")).toBeNull();
    expect(noTlsMessage("mysql", new Error("Access denied for user"), "mysql://h/db")).toBeNull();
  });
});
