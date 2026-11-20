
import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { verifySignedRequest } from "../signed-request";

const SECRET = "test-app-secret-do-not-use";

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64url");
}

function sign(
  payload: Record<string, unknown>,
  secret = SECRET,
): string {
  const payloadPart = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac("sha256", secret).update(payloadPart, "utf8").digest();
  return `${b64url(sig)}.${payloadPart}`;
}

const VALID_PAYLOAD = {
  algorithm: "HMAC-SHA256",
  issued_at: 1_780_000_000,
  user_id: "1234567890123456",
};

describe("valid signed_request", () => {
  it("returns the payload when the signature matches", () => {
    const out = verifySignedRequest(sign(VALID_PAYLOAD), SECRET);
    expect(out).toEqual({ user_id: "1234567890123456", issued_at: 1_780_000_000 });
  });

  it("accepts a payload with no issued_at, reporting it as null", () => {
    const out = verifySignedRequest(
      sign({ algorithm: "HMAC-SHA256", user_id: "42" }),
      SECRET,
    );
    expect(out).toEqual({ user_id: "42", issued_at: null });
  });

  it("verifies against the encoded payload string, not the re-serialized JSON", () => {
    const raw = '{ "user_id": "99", "algorithm": "HMAC-SHA256", "issued_at": 1 }';
    const payloadPart = b64url(raw);
    const sig = crypto.createHmac("sha256", SECRET).update(payloadPart, "utf8").digest();
    const out = verifySignedRequest(`${b64url(sig)}.${payloadPart}`, SECRET);
    expect(out?.user_id).toBe("99");
  });
});

describe("rejects anything not signed by the app secret", () => {
  it("rejects a signature made with a different secret", () => {
    expect(verifySignedRequest(sign(VALID_PAYLOAD, "wrong-secret"), SECRET)).toBeNull();
  });

  it("rejects a tampered payload carrying the original signature", () => {
    const original = sign(VALID_PAYLOAD);
    const [sig] = original.split(".");
    const swapped = b64url(JSON.stringify({ ...VALID_PAYLOAD, user_id: "attacker" }));
    expect(verifySignedRequest(`${sig}.${swapped}`, SECRET)).toBeNull();
  });

  it("rejects an unsigned payload with an empty signature part", () => {
    const payloadPart = b64url(JSON.stringify(VALID_PAYLOAD));
    expect(verifySignedRequest(`.${payloadPart}`, SECRET)).toBeNull();
  });

  it("rejects a truncated signature", () => {
    const [sig, payloadPart] = sign(VALID_PAYLOAD).split(".");
    expect(verifySignedRequest(`${sig.slice(0, 10)}.${payloadPart}`, SECRET)).toBeNull();
  });
});

describe("rejects algorithm downgrades", () => {
  it.each(["none", "NONE", "hmac-sha256", "HMAC-SHA1", "", null, 0])(
    "rejects algorithm=%p even when the HMAC itself is correct",
    (algorithm) => {
      const out = verifySignedRequest(
        sign({ ...VALID_PAYLOAD, algorithm }),
        SECRET,
      );
      expect(out).toBeNull();
    },
  );

  it("rejects a payload with no algorithm field at all", () => {
    expect(verifySignedRequest(sign({ user_id: "42" }), SECRET)).toBeNull();
  });
});

describe("rejects malformed input without throwing", () => {
  it.each([
    ["empty string", ""],
    ["no separator", "abcdef"],
    ["three parts", "a.b.c"],
    ["empty payload part", "abc."],
    ["payload is not JSON", `${b64url("sig")}.${b64url("not json at all")}`],
    ["payload is a JSON array", `${b64url("sig")}.${b64url("[1,2,3]")}`],
    ["payload is a JSON string", `${b64url("sig")}.${b64url('"hello"')}`],
    ["payload is null", `${b64url("sig")}.${b64url("null")}`],
  ])("returns null for %s", (_label, input) => {
    expect(() => verifySignedRequest(input, SECRET)).not.toThrow();
    expect(verifySignedRequest(input, SECRET)).toBeNull();
  });

  it("returns null when the app secret is missing", () => {
    expect(verifySignedRequest(sign(VALID_PAYLOAD), "")).toBeNull();
  });

  it("returns null when user_id is absent or not a string", () => {
    expect(verifySignedRequest(sign({ algorithm: "HMAC-SHA256" }), SECRET)).toBeNull();
    expect(
      verifySignedRequest(sign({ algorithm: "HMAC-SHA256", user_id: 42 }), SECRET),
    ).toBeNull();
    expect(
      verifySignedRequest(sign({ algorithm: "HMAC-SHA256", user_id: "" }), SECRET),
    ).toBeNull();
  });
});
