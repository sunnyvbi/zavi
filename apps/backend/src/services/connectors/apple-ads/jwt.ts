
import { createPrivateKey, sign } from "node:crypto";

export type ClientSecretInput = {
  clientId: string;
  teamId: string;
  keyId: string;
  privateKeyPem: string;
  lifetimeSeconds?: number;
};

const b64url = (d: Buffer | string): string => Buffer.from(d).toString("base64url");

export function createAppleClientSecret(input: ClientSecretInput, now = new Date()): string {
  const iat = Math.floor(now.getTime() / 1000);
  const lifetime = Math.min(input.lifetimeSeconds ?? 3600, 180 * 86_400 - 60);
  const header = { alg: "ES256", kid: input.keyId };
  const payload = { iss: input.teamId, iat, exp: iat + lifetime, aud: "https://appleid.apple.com", sub: input.clientId };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const key = createPrivateKey(input.privateKeyPem);
  const signature = sign("sha256", Buffer.from(signingInput), { key, dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${b64url(signature)}`;
}
