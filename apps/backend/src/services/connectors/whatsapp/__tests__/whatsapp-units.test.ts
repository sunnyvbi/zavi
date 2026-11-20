
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import { verifyHubSignature256 } from "@/services/connectors/hub-signature";
import { whatsappEnabled, whatsappEnv } from "@/services/connectors/whatsapp/adapter";
import { windowIsOpen, chunkWhatsAppText, WINDOW_SAFETY_BUFFER_MS } from "@/services/tools/whatsapp/_client";
import { extractBindToken } from "@/services/connectors/bind-code";

const ENV_KEYS = [
  "WHATSAPP_ACCESS_TOKEN",
  "WHATSAPP_PHONE_NUMBER_ID",
  "WHATSAPP_APP_SECRET",
  "WHATSAPP_VERIFY_TOKEN",
  "WHATSAPP_BUSINESS_NUMBER",
] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("SAFE-INERT gate", () => {
  it("is OFF with no secrets — this is what makes merging a no-op", () => {
    expect(whatsappEnabled()).toBe(false);
    expect(whatsappEnv()).toBeNull();
  });

  it("stays OFF when only SOME secrets are present (no half-armed surface)", () => {
    process.env.WHATSAPP_ACCESS_TOKEN = "t";
    process.env.WHATSAPP_PHONE_NUMBER_ID = "p";
    expect(whatsappEnabled()).toBe(false);
    process.env.WHATSAPP_APP_SECRET = "s";
    expect(whatsappEnabled()).toBe(false);
    process.env.WHATSAPP_VERIFY_TOKEN = "v";
    expect(whatsappEnabled()).toBe(true);
  });

  it("pins the Graph API version rather than tracking 'latest'", () => {
    for (const k of ENV_KEYS) process.env[k] = "x";
    expect(whatsappEnv()!.graphVersion).toMatch(/^v\d+\.\d+$/);
  });

  it("strips non-digits from the business number so the wa.me link is well-formed", () => {
    for (const k of ENV_KEYS) process.env[k] = "x";
    process.env.WHATSAPP_BUSINESS_NUMBER = "+1 (415) 969-9735";
    expect(whatsappEnv()!.businessNumber).toBe("14159699735");
  });
});

describe("verifyHubSignature256 (shared with the GitHub webhook)", () => {
  const secret = "app-secret";
  const body = Buffer.from(JSON.stringify({ hello: "world" }));
  const good = "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");

  it("accepts a correct signature", () => {
    expect(verifyHubSignature256(body, good, secret)).toBe(true);
  });

  it("rejects a body tampered by even one byte", () => {
    expect(verifyHubSignature256(Buffer.from('{"hello":"worlD"}'), good, secret)).toBe(false);
  });

  it("rejects the right digest under the wrong secret", () => {
    expect(verifyHubSignature256(body, good, "other-secret")).toBe(false);
  });

  it("rejects malformed headers without throwing", () => {
    for (const sig of ["", "deadbeef", "sha1=abc", "sha256=", "sha256=zz"]) {
      expect(verifyHubSignature256(body, sig, secret)).toBe(false);
    }
  });

  it("returns false — never throws — on an empty secret", () => {
    expect(verifyHubSignature256(body, good, "")).toBe(false);
  });
});

describe("24h window gate", () => {
  const now = Date.parse("2026-09-01T12:00:00Z");

  it("is CLOSED when there is no deadline at all (fail closed)", () => {
    expect(windowIsOpen(null, now)).toBe(false);
    expect(windowIsOpen(undefined, now)).toBe(false);
    expect(windowIsOpen("not-a-date", now)).toBe(false);
  });

  it("is open comfortably inside the window", () => {
    expect(windowIsOpen(new Date(now + 3600_000).toISOString(), now)).toBe(true);
  });

  it("is CLOSED after the deadline", () => {
    expect(windowIsOpen(new Date(now - 1000).toISOString(), now)).toBe(false);
  });

  it("treats the last 60s as CLOSED — a send that lands late fails hard and the user gets NOTHING", () => {
    const justInside = new Date(now + WINDOW_SAFETY_BUFFER_MS - 1000).toISOString();
    expect(windowIsOpen(justInside, now)).toBe(false);
    const safelyOutside = new Date(now + WINDOW_SAFETY_BUFFER_MS + 1000).toISOString();
    expect(windowIsOpen(safelyOutside, now)).toBe(true);
  });
});

describe("bind token extraction (rides the user-EDITABLE prefill)", () => {
  it("extracts the token from the canonical prefill", () => {
    expect(extractBindToken("Connect Zavi: abcDEF123456_-xyz")).toBe("abcDEF123456_-xyz");
  });

  it("is case-insensitive and tolerates the user retyping around it", () => {
    expect(extractBindToken("hey connect zavi: abcDEF123456_-xyz thanks")).toBe("abcDEF123456_-xyz");
  });

  it("returns null for ordinary chatter so a normal message is never a bind attempt", () => {
    for (const s of ["hello", "connect me to zavi", "what is my ad spend?", ""]) {
      expect(extractBindToken(s)).toBeNull();
    }
  });

  it("ignores a too-short token (bounded so junk can't reach the RPC)", () => {
    expect(extractBindToken("Connect Zavi: short")).toBeNull();
  });
});

describe("chunking", () => {
  it("keeps every chunk within the Cloud API 4096 cap", () => {
    for (const c of chunkWhatsAppText("x".repeat(10_000))) {
      expect(c.length).toBeLessThanOrEqual(4096);
    }
  });

  it("does not lose content", () => {
    const text = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    expect(chunkWhatsAppText(text).join("").replace(/\s/g, "")).toBe(text.replace(/\s/g, ""));
  });
});
