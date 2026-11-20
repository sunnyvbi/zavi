import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { verifySendGridSignature } from "@/routes/webhooks/sendgrid-events";

function makeKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const publicKeyBase64 = publicKey
    .export({ type: "spki", format: "pem" })
    .toString()
    .replace(/-----(BEGIN|END) PUBLIC KEY-----/g, "")
    .replace(/\s+/g, "");
  return { publicKeyBase64, privateKey };
}

function sign(privateKey: crypto.KeyObject, timestamp: string, body: Buffer): string {
  const payload = Buffer.concat([Buffer.from(timestamp, "utf8"), body]);
  return crypto.sign("sha256", payload, { key: privateKey, dsaEncoding: "der" }).toString("base64");
}

describe("verifySendGridSignature", () => {
  const body = Buffer.from(JSON.stringify([{ email: "a@b.com", event: "spamreport" }]));
  const timestamp = "1783950000";

  it("accepts a genuinely signed payload", () => {
    const { publicKeyBase64, privateKey } = makeKeypair();
    const sig = sign(privateKey, timestamp, body);
    expect(verifySendGridSignature(publicKeyBase64, body, timestamp, sig)).toBe(true);
  });

  it("REJECTS a payload signed by the wrong key (a forged event)", () => {
    const real = makeKeypair();
    const attacker = makeKeypair();
    const sig = sign(attacker.privateKey, timestamp, body);
    expect(verifySendGridSignature(real.publicKeyBase64, body, timestamp, sig)).toBe(false);
  });

  it("REJECTS a tampered body — the signature must cover the events themselves", () => {
    const { publicKeyBase64, privateKey } = makeKeypair();
    const sig = sign(privateKey, timestamp, body);
    const tampered = Buffer.from(JSON.stringify([{ email: "victim@corp.com", event: "spamreport" }]));
    expect(verifySendGridSignature(publicKeyBase64, tampered, timestamp, sig)).toBe(false);
  });

  it("REJECTS a swapped timestamp — the signature must cover it (replay defense)", () => {
    const { publicKeyBase64, privateKey } = makeKeypair();
    const sig = sign(privateKey, timestamp, body);
    expect(verifySendGridSignature(publicKeyBase64, body, "1799999999", sig)).toBe(false);
  });

  it("fails CLOSED on a missing signature, timestamp, or key", () => {
    const { publicKeyBase64, privateKey } = makeKeypair();
    const sig = sign(privateKey, timestamp, body);
    expect(verifySendGridSignature(publicKeyBase64, body, timestamp, "")).toBe(false);
    expect(verifySendGridSignature(publicKeyBase64, body, "", sig)).toBe(false);
    expect(verifySendGridSignature("", body, timestamp, sig)).toBe(false);
  });

  it("fails CLOSED on garbage input rather than throwing", () => {
    expect(verifySendGridSignature("not-a-key", Buffer.from("{}"), "1", "not-a-sig")).toBe(false);
    expect(() =>
      verifySendGridSignature("not-a-key", Buffer.from("{}"), "1", "not-a-sig"),
    ).not.toThrow();
  });
});
