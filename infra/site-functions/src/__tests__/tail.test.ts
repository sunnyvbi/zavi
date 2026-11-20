import { describe, expect, it } from "vitest";
import { handleTail, toEntries } from "../tail";
import { redactSecrets, verifyLogBatch } from "../shared";

const SCRIPT = "zfn-11111111111141118111111111111111-3";
const NOW = Date.UTC(2026, 9, 2, 12, 0, 0);
const FAKE_STRIPE = ["sk", "live", "51H" + "x".repeat(20) + "Q"].join("_");
const FAKE_WHSEC = ["whsec", "abcdefghijklmnop"].join("_");

describe("tail worker", () => {
  it("keeps only known site scripts, redacts credentials, drops query strings", () => {
    const out = toEntries([
      {
        scriptName: SCRIPT, outcome: "ok", eventTimestamp: NOW,
        event: { request: { url: "https://shop.example.com/api/hooks/stripe?token=abc", method: "POST" }, response: { status: 200 } },
        logs: [
          { level: "log", message: ["charge with", FAKE_STRIPE], timestamp: NOW },
          { level: "warn", message: ["auth", "Bearer " + ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxIn0", "c2lnbmF0dXJl"].join(".")], timestamp: NOW },
        ],
        exceptions: [{ name: "TypeError", message: `boom ${FAKE_WHSEC}`, timestamp: NOW }],
      },
      { scriptName: "some-other-worker", outcome: "ok", logs: [{ level: "log", message: ["x"] }] },
    ]);
    expect(out).toHaveLength(3);
    expect(out.every((e) => e.script === SCRIPT && e.path === "/api/hooks/stripe")).toBe(true);
    const text = JSON.stringify(out);
    expect(text).not.toContain(FAKE_STRIPE);
    expect(text).not.toContain(FAKE_WHSEC);
    expect(text).not.toContain("eyJzdWIi");
    expect(text).not.toContain("token=abc");
    expect(out[1].level).toBe("warn");
    expect(out[2].level).toBe("error");
  });

  it("records a failed invocation with no output", () => {
    const out = toEntries([{ scriptName: SCRIPT, outcome: "exceededCpu", eventTimestamp: NOW }]);
    expect(out).toEqual([expect.objectContaining({ level: "error", message: "invocation ended: exceededCpu" })]);
  });

  it("posts a signed batch the backend can verify", async () => {
    let got: { headers: Headers; body: Uint8Array } | null = null;
    const fetchFn = (async (_u: string, init: RequestInit) => {
      got = { headers: new Headers(init.headers), body: init.body as Uint8Array };
      return new Response("{}");
    }) as unknown as typeof fetch;
    await handleTail([{ scriptName: SCRIPT, outcome: "ok", logs: [{ level: "log", message: ["hi"] }] }], { FN_LOG_INGEST_URL: "https://api/x", FN_LOG_SECRET: "log-secret-0123456789" }, fetchFn, () => NOW);
    expect(got).not.toBeNull();
    expect(await verifyLogBatch("log-secret-0123456789", got!.headers, got!.body, NOW)).toBe(true);
    expect(await verifyLogBatch("other", got!.headers, got!.body, NOW)).toBe(false);
  });

  it("redaction leaves ordinary text alone", () => {
    expect(redactSecrets("order 42 paid by ana@example.com")).toBe("order 42 paid by ana@example.com");
  });
});
