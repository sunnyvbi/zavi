
import { describe, it, expect, vi } from "vitest";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  signVoiceCallbackBody,
  verifyVoiceCallbackSignature,
  checkAndConsumeNonce,
  HMAC_HEADER_SIG,
  HMAC_HEADER_EVENT_ID,
  HMAC_HEADER_IAT,
} from "../sidecar-hmac";

const SECRET = "test-secret-key-32-bytes-of-entropy-here";
const WRONG_SECRET = "different-key-that-should-not-verify";

function makeBody(): Buffer {
  return Buffer.from(
    JSON.stringify({ session_id: "abc-123", text: "hello" }),
    "utf8",
  );
}

function makeHeaders(body: Buffer, secret: string, now: number) {
  return {
    [HMAC_HEADER_SIG.toLowerCase()]: signVoiceCallbackBody(body, secret),
    [HMAC_HEADER_EVENT_ID.toLowerCase()]: "11111111-1111-4111-8111-111111111111",
    [HMAC_HEADER_IAT.toLowerCase()]: String(now),
  } satisfies Record<string, string>;
}

describe("voice sidecar HMAC — verifyVoiceCallbackSignature", () => {
  const now = Date.UTC(2026, 4, 21, 19, 0, 0);

  it("signed-ok: correctly-signed body within iat window passes", () => {
    const body = makeBody();
    const headers = makeHeaders(body, SECRET, now);
    const out = verifyVoiceCallbackSignature(body, headers, SECRET, now);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.eventId).toBe("11111111-1111-4111-8111-111111111111");
    }
  });

  it("wrong-key: signature computed with a different key is rejected", () => {
    const body = makeBody();
    const headers = makeHeaders(body, WRONG_SECRET, now);
    const out = verifyVoiceCallbackSignature(body, headers, SECRET, now);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("bad_signature");
  });

  it("out-of-window-iat: 70s old timestamp is rejected (window is ±60s)", () => {
    const body = makeBody();
    const stale = now - 70_000;
    const headers = {
      ...makeHeaders(body, SECRET, stale),
      [HMAC_HEADER_IAT.toLowerCase()]: String(stale),
    };
    const out = verifyVoiceCallbackSignature(body, headers, SECRET, now);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("bad_iat");
  });

  it("missing-secret: server with no secret env-var refuses everything", () => {
    const body = makeBody();
    const headers = makeHeaders(body, SECRET, now);
    const out = verifyVoiceCallbackSignature(body, headers, "", now);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("missing_secret");
  });

  it("missing-header: dropping the sig header is rejected", () => {
    const body = makeBody();
    const { [HMAC_HEADER_SIG.toLowerCase()]: _drop, ...rest } = makeHeaders(
      body,
      SECRET,
      now,
    );
    void _drop;
    const out = verifyVoiceCallbackSignature(body, rest, SECRET, now);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("missing_header");
  });

  it("tampered-body: signature over original body fails on modified body", () => {
    const original = makeBody();
    const tampered = Buffer.from(
      JSON.stringify({ session_id: "abc-123", text: "EVIL" }),
      "utf8",
    );
    const headers = makeHeaders(original, SECRET, now);
    const out = verifyVoiceCallbackSignature(tampered, headers, SECRET, now);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("bad_signature");
  });
});

describe("voice sidecar HMAC — checkAndConsumeNonce (mocked SupabaseClient)", () => {
  function mockSupabase(behavior: "first" | "duplicate" | "boom") {
    return {
      from: vi.fn().mockReturnValue({
        insert: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue(
              behavior === "first"
                ? { data: { event_id: "abc" }, error: null }
                : behavior === "duplicate"
                  ? { data: null, error: { code: "23505" } }
                  : { data: null, error: { code: "PGRST500", message: "boom" } },
            ),
          }),
        }),
      }),
    } as unknown as Parameters<typeof checkAndConsumeNonce>[0];
  }

  it("replay-by-jti: first call ok, second-call same id is replay", async () => {
    const supa = mockSupabase("first");
    const first = await checkAndConsumeNonce(supa, "abc");
    expect(first.ok).toBe(true);

    const dup = mockSupabase("duplicate");
    const second = await checkAndConsumeNonce(dup, "abc");
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("replay");
  });

  it("DB error other than 23505 surfaces (caller decides fail-closed)", async () => {
    const supa = mockSupabase("boom");
    await expect(checkAndConsumeNonce(supa, "x")).rejects.toMatchObject({
      code: "PGRST500",
    });
  });
});

const SIDECAR_PY = resolve(
  __dirname,
  "../../../../../voice-pipeline/sidecar.py",
);

function pythonAvailable(): boolean {
  if (!existsSync(SIDECAR_PY)) return false;
  const probe = spawnSync("python3", ["--version"], { encoding: "utf8" });
  return probe.status === 0;
}

function extractPyFunc(source: string, name: string): string | null {
  const lines = source.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`def ${name}(`));
  if (start === -1) return null;
  const out = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.length > 0 && !/^\s/.test(l)) break;
    out.push(l);
  }
  return out.join("\n");
}

function runPySigner(
  funcName: string,
  secret: string,
  bodiesHex: string[],
): string[] {
  const source = readFileSync(SIDECAR_PY, "utf8");
  const fnSrc = extractPyFunc(source, funcName);
  if (!fnSrc) throw new Error(`could not extract ${funcName} from sidecar.py`);
  const driver = [
    "import hashlib, hmac, base64, json, sys",
    `HMAC_SECRET = ${JSON.stringify(secret)}`,
    fnSrc,
    "bodies = json.loads(sys.argv[1])",
    `print(json.dumps([${funcName}(bytes.fromhex(h)) for h in bodies]))`,
  ].join("\n");
  const res = spawnSync("python3", ["-c", driver, JSON.stringify(bodiesHex)], {
    encoding: "utf8",
  });
  if (res.status !== 0) {
    throw new Error(`python signer failed: ${res.stderr || res.stdout}`);
  }
  return JSON.parse(res.stdout.trim());
}

const PARITY_SECRET = "test-secret-key-32-bytes-of-entropy-here";

const PARITY_FIXTURES: Buffer[] = [
  Buffer.from("", "utf8"),
  Buffer.from(JSON.stringify({ session_id: "abc-123", text: "hello" }), "utf8"),
  Buffer.from('{"session_id":"abc-123","user_text":"what about my ads?"}', "utf8"),
  Buffer.from('{"emoji":"🚗","note":"naïve café"}', "utf8"),
  Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x7f, 0x80]),
];

const HAS_PYTHON = pythonAvailable();

describe.skipIf(!HAS_PYTHON)(
  "voice sidecar HMAC — Python ↔ Node signature parity",
  () => {
    it("Python _sign_base64url matches Node signVoiceCallbackBody byte-for-byte", () => {
      const hexes = PARITY_FIXTURES.map((b) => b.toString("hex"));
      const pySigs = runPySigner("_sign_base64url", PARITY_SECRET, hexes);
      const nodeSigs = PARITY_FIXTURES.map((b) =>
        signVoiceCallbackBody(b, PARITY_SECRET),
      );
      expect(pySigs).toEqual(nodeSigs);
    });

    it("a Python-signed body verifies on the Node side (round-trip)", () => {
      const body = PARITY_FIXTURES[1];
      const [pySig] = runPySigner("_sign_base64url", PARITY_SECRET, [
        body.toString("hex"),
      ]);
      const now = Date.now();
      const headers = {
        [HMAC_HEADER_SIG.toLowerCase()]: pySig,
        [HMAC_HEADER_EVENT_ID.toLowerCase()]: "22222222-2222-4222-8222-222222222222",
        [HMAC_HEADER_IAT.toLowerCase()]: String(now),
      };
      const out = verifyVoiceCallbackSignature(body, headers, PARITY_SECRET, now);
      expect(out.ok).toBe(true);
    });

    it("a different secret on the Python side does NOT verify on Node (contract is keyed)", () => {
      const body = PARITY_FIXTURES[1];
      const [pySig] = runPySigner("_sign_base64url", "the-wrong-secret", [
        body.toString("hex"),
      ]);
      const now = Date.now();
      const headers = {
        [HMAC_HEADER_SIG.toLowerCase()]: pySig,
        [HMAC_HEADER_EVENT_ID.toLowerCase()]: "33333333-3333-4333-8333-333333333333",
        [HMAC_HEADER_IAT.toLowerCase()]: String(now),
      };
      const out = verifyVoiceCallbackSignature(body, headers, PARITY_SECRET, now);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe("bad_signature");
    });

    it("the DEAD _sign (hex) signer DIVERGES from Node — guards against re-pointing the sender", () => {
      const hexes = PARITY_FIXTURES.map((b) => b.toString("hex"));
      const deadSigs = runPySigner("_sign", PARITY_SECRET, hexes);
      const nodeSigs = PARITY_FIXTURES.map((b) =>
        signVoiceCallbackBody(b, PARITY_SECRET),
      );
      deadSigs.forEach((sig, i) => {
        expect(sig).not.toBe(nodeSigs[i]);
      });
      const body = PARITY_FIXTURES[1];
      const now = Date.now();
      const headers = {
        [HMAC_HEADER_SIG.toLowerCase()]: deadSigs[1],
        [HMAC_HEADER_EVENT_ID.toLowerCase()]: "44444444-4444-4444-8444-444444444444",
        [HMAC_HEADER_IAT.toLowerCase()]: String(now),
      };
      const out = verifyVoiceCallbackSignature(body, headers, PARITY_SECRET, now);
      expect(out.ok).toBe(false);
    });
  },
);
