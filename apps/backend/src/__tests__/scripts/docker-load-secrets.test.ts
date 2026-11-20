import { describe, expect, it, vi } from "vitest";
import dotenv from "dotenv";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { escapeDotenvValue, jsonToDotenv, mergeSecretLayers, overlayProblem } = require("../../../scripts/docker-load-secrets.cjs") as {
  mergeSecretLayers: (c: Record<string, string>, r: Record<string, string>, o?: Record<string, string>) => Record<string, string>;
  overlayProblem: (r: Record<string, string>, o: Record<string, string>) => string | null;
  escapeDotenvValue: (v: string, key?: string) => string;
  jsonToDotenv: (o: Record<string, unknown>) => string;
};

const roundTrip = (v: string) => dotenv.parse(jsonToDotenv({ K: v })).K;

describe("docker-load-secrets writes values dotenv reads back exactly", () => {
  const kek = JSON.stringify({ kty: "EC", crv: "P-256", x: "abc_-123", y: "def", kid: "zavi-kek-20261001-f093ef" });
  const cases: Record<string, string> = {
    "plain token": "sk_live_abc123",
    "JSON public key (the 2026-10-01 bug)": kek,
    "JSON with a single quote": JSON.stringify({ note: "it's fine" }),
    "PEM with real newlines": "-----BEGIN PRIVATE KEY-----\nMIIabc\ndef==\n-----END PRIVATE KEY-----\n",
    "hash sign": "abc#def",
    backslashes: "C:\\path\\to\\thing \\n not a newline",
    "leading and trailing space": "  padded  ",
    "single and double quotes": `he said "it's" fine`,
    "url with query": "https://api.zaviagent.com/x?a=1&b=2",
    "single quote and backtick, literal backslash-n": "single' tick` literal\\n",
    "single quote and backtick, plain": "it's `fine`",
    empty: "",
  };
  for (const [name, value] of Object.entries(cases)) {
    it(name, () => {
      expect(roundTrip(value)).toBe(value);
    });
  }

  it("the KEK parses as the public JWK shape the signer check needs", () => {
    const j = JSON.parse(roundTrip(kek));
    expect(j).toMatchObject({ kty: "EC", crv: "P-256", kid: "zavi-kek-20261001-f093ef" });
  });

  it("all three quote characters (no #, newline or edge space) round-trip exactly", () => {
    expect(roundTrip(`a'b"c\`d`)).toBe(`a'b"c\`d`);
  });

  it("a value with no exact dotenv form never blocks the boot and warns with the key only", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => escapeDotenvValue(`a'b"c\`d #x`, "ODD_KEY")).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("ODD_KEY"));
    expect(String(warn.mock.calls[0][0])).not.toContain("a'b");
    warn.mockRestore();
  });

  it("a carriage return round-trips exactly", () => {
    expect(roundTrip("pa\rss")).toBe("pa\rss");
    expect(roundTrip("line1\r\nline2")).toBe("line1\r\nline2");
  });

  it("a value starting with a quote char that appears nowhere else round-trips", () => {
    expect(roundTrip(`"a'b\`c`)).toBe(`"a'b\`c`);
  });

  it("many keys in one file all survive", () => {
    const vars = { A: "1", B: kek, C: "x#y", D: "line1\nline2" };
    expect(dotenv.parse(jsonToDotenv(vars))).toEqual(vars);
  });
});

describe("docker-load-secrets layers (worker overlay, PLAN-backend-worker-split.md)", () => {
  it("the worker's overlay wins over praxis-envprod-1; everything else comes from the shared secret", () => {
    const merged = mergeSecretLayers(
      {},
      { INNGEST_SERVE_HOST: "https://api.zaviagent.com", STRIPE_KEY: "sk", SUPABASE_URL: "u" },
      { INNGEST_SERVE_HOST: "https://jobs.zaviagent.com", INNGEST_SELF_SYNC_URL: "https://jobs.zaviagent.com/api/inngest" },
    );
    expect(merged).toEqual({
      INNGEST_SERVE_HOST: "https://jobs.zaviagent.com",
      INNGEST_SELF_SYNC_URL: "https://jobs.zaviagent.com/api/inngest",
      STRIPE_KEY: "sk",
      SUPABASE_URL: "u",
    });
  });

  it("without an overlay (the API host) the result is today's merge", () => {
    expect(mergeSecretLayers({ A: "common" }, { A: "role", B: "b" })).toEqual({ A: "role", B: "b" });
  });
});

describe("docker-load-secrets: a worker overlay that would not move Inngest refuses to start", () => {
  const shared = { INNGEST_SERVE_HOST: "https://api.zaviagent.com" };
  const good = {
    INNGEST_SERVE_HOST: "https://jobs.zaviagent.com",
    INNGEST_SELF_SYNC_URL: "https://jobs.zaviagent.com/api/inngest",
  };

  it("accepts the worker's own URLs", () => {
    expect(overlayProblem(shared, good)).toBeNull();
  });

  it("refuses an empty, misspelled or blank overlay", () => {
    expect(overlayProblem(shared, {})).toMatch(/must set/);
    expect(overlayProblem(shared, { INNGEST_SERVEHOST: good.INNGEST_SERVE_HOST, INNGEST_SELF_SYNC_URL: good.INNGEST_SELF_SYNC_URL })).toMatch(/must set/);
    expect(overlayProblem(shared, { ...good, INNGEST_SELF_SYNC_URL: "" })).toMatch(/must set/);
  });

  it("refuses a sync URL on another host, and the API host's URL pasted in", () => {
    expect(overlayProblem(shared, { ...good, INNGEST_SELF_SYNC_URL: "https://api.zaviagent.com/api/inngest" })).toMatch(/must be/);
    expect(
      overlayProblem(shared, {
        INNGEST_SERVE_HOST: "https://api.zaviagent.com/",
        INNGEST_SELF_SYNC_URL: "https://api.zaviagent.com/api/inngest",
      }),
    ).toMatch(/same as the shared/);
  });
});
