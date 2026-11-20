import { describe, it, expect } from "vitest";
import { generateKeyPairSync, verify } from "node:crypto";
import { createAppleClientSecret } from "../jwt";

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const input = { clientId: "SEARCHADS.11111111-1111-1111-1111-111111111111", teamId: "SEARCHADS.11111111-1111-1111-1111-111111111111", keyId: "KEY1", privateKeyPem: pem };

function parts(jwt: string) {
  const [h, p, s] = jwt.split(".");
  return { header: JSON.parse(Buffer.from(h, "base64url").toString()), payload: JSON.parse(Buffer.from(p, "base64url").toString()), sig: Buffer.from(s, "base64url"), signingInput: `${h}.${p}` };
}

describe("createAppleClientSecret", () => {
  it("emits ES256 with kid, and Apple's exact claim set", () => {
    const { header, payload } = parts(createAppleClientSecret(input, new Date(1_700_000_000_000)));
    expect(header).toEqual({ alg: "ES256", kid: "KEY1" });
    expect(payload.iss).toBe(input.teamId);
    expect(payload.sub).toBe(input.clientId);
    expect(payload.aud).toBe("https://appleid.apple.com");
    expect(payload.iat).toBe(1_700_000_000);
    expect(payload.exp).toBe(1_700_000_000 + 3600);
  });
  it("signature is raw r||s (64 bytes) and verifies — NOT ASN.1 DER", () => {
    const { sig, signingInput } = parts(createAppleClientSecret(input));
    expect(sig.length).toBe(64);
    expect(verify("sha256", Buffer.from(signingInput), { key: publicKey, dsaEncoding: "ieee-p1363" }, sig)).toBe(true);
  });
  it("caps exp at iat + 180 days even if asked for more", () => {
    const { payload } = parts(createAppleClientSecret({ ...input, lifetimeSeconds: 10 * 365 * 86_400 }, new Date(0)));
    expect(payload.exp).toBeLessThanOrEqual(180 * 86_400);
  });
  it("throws on a malformed key rather than emitting an unsigned token", () => {
    expect(() => createAppleClientSecret({ ...input, privateKeyPem: "-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----" })).toThrow();
  });
});
