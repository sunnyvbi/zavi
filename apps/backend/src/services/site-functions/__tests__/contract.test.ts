import { afterEach, describe, expect, it } from "vitest";
import {
  findSecretLikeTokens,
  getSiteFunctionsService,
  redactSecretLike,
  secretNameIssue,
  secretValueIssue,
  setSiteFunctionsService,
  type SiteFunctionsService,
} from "../contract";

const k = (...parts: string[]) => parts.join("_");
const STRIPE_LIVE = k("sk", "live", "51Hxyzabcdefghijklmnopqrstuvwxyz");
const STRIPE_RESTRICTED = k("rk", "test", "abcdefghij1234567890ABCDEF");
const WHSEC = k("whsec", "abcdefghijklmnopqrstuvwxyz12");

describe("findSecretLikeTokens", () => {
  it("finds keys people paste by mistake", () => {
    expect(findSecretLikeTokens(`my key is ${STRIPE_LIVE} ok`)).toEqual(["stripe_secret_key"]);
    expect(findSecretLikeTokens(STRIPE_RESTRICTED)).toEqual(["stripe_secret_key"]);
    expect(findSecretLikeTokens(WHSEC)).toEqual(["stripe_webhook_secret"]);
    expect(findSecretLikeTokens("AKIA" + "ABCDEFGHIJKLMNOP")).toEqual(["aws_access_key"]);
    expect(findSecretLikeTokens(k("ghp", "abcdefghijklmnopqrstuvwxyz0123"))).toEqual(["github_token"]);
    expect(findSecretLikeTokens("-----BEGIN RSA PRIVATE KEY-----\nabc")).toEqual(["private_key"]);
  });

  it("leaves ordinary messages, placeholders and publishable keys alone", () => {
    expect(findSecretLikeTokens("Add a Stripe checkout for the dog wash, $25")).toEqual([]);
    expect(findSecretLikeTokens(`where does ${k("sk", "test", "abcdefghij")} go?`)).toEqual([]);
    expect(findSecretLikeTokens(`${k("pk", "test", "51Habcdefghijklmnopqrstuvwxyz")} is the publishable key`)).toEqual([]);
    expect(findSecretLikeTokens("set STRIPE_SECRET_KEY in settings")).toEqual([]);
    expect(findSecretLikeTokens(null)).toEqual([]);
  });

  it("finds database URLs with a password and service-role JWTs, not the public anon key", () => {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const jwt = (role: string) => ["eyJ" + b64({ alg: "HS256" }).slice(3), b64({ iss: "supabase", role, ref: "abcdefghijkl" }), "s".repeat(43)].join(".");
    const url = ["postgres", "://", "app", ":", "hunter2hunter2", "@", "db.example.com:5432/app"].join("");
    expect(findSecretLikeTokens(`connect with ${url}`)).toEqual(["database_url"]);
    expect(findSecretLikeTokens("postgres://localhost:5432/app is the dev db")).toEqual([]);
    expect(findSecretLikeTokens(["POSTGRESQL", "://", "app", ":", "p4ss", "@", "db.example.com/app"].join(""))).toEqual(["database_url"]);
    expect(findSecretLikeTokens(["redis", "://", ":", "tok", "@", "cache.example.com:6379"].join(""))).toEqual(["database_url"]);
    expect(findSecretLikeTokens(`service key ${jwt("service_role")}`)).toEqual(["service_role_key"]);
    expect(findSecretLikeTokens(`anon key ${jwt("anon")}`)).toEqual([]);
    expect(redactSecretLike(`a ${jwt("service_role")} b ${jwt("anon")}`)).toBe(`a [secret] b ${jwt("anon")}`);
    expect(redactSecretLike(`x ${url} y`)).toBe("x [secret] y");
  });

  it("redacts every match", () => {
    expect(redactSecretLike(`a ${STRIPE_LIVE} b ${WHSEC} c`)).toBe("a [secret] b [secret] c");
  });
});

describe("secret input checks", () => {
  it("names are UPPER_SNAKE and not reserved; values are 8+ characters and bounded", () => {
    expect(secretNameIssue("STRIPE_SECRET_KEY")).toBeNull();
    expect(secretNameIssue("stripe")).not.toBeNull();
    expect(secretNameIssue("ZAVI_INTERNAL")).toMatch(/reserved/);
    expect(secretValueIssue("12345678")).toBeNull();
    expect(secretValueIssue("short")).toMatch(/at least 8/);
    expect(secretValueIssue("")).not.toBeNull();
    expect(secretValueIssue("x".repeat(8193))).not.toBeNull();
  });
});

describe("service registry", () => {
  afterEach(() => setSiteFunctionsService(null));
  it("is empty until the runtime registers", () => {
    expect(getSiteFunctionsService()).toBeNull();
    const svc = {} as SiteFunctionsService;
    setSiteFunctionsService(svc);
    expect(getSiteFunctionsService()).toBe(svc);
  });
});
