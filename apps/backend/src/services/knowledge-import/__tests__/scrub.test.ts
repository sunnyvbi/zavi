import { describe, it, expect } from "vitest";
import { scrubDocumentText } from "../scrub";

const cases: Array<[string, string]> = [
  ["STRIPE_SECRET_KEY=sk_live_" + "a".repeat(24), "sk_live_"],
  ["DATABASE_URL=postgres://admin:hunter2pass@db.example.com:5432/app", "hunter2pass"],
  ["password: Tr0ub4dor&3xyz", "Tr0ub4dor"],
  ["password=abc", "=abc"],
  ["export OPENAI_API_KEY=sk-" + "b".repeat(30), "sk-bbbb"],
  ["key: sk-ant-api03-" + "c".repeat(30), "sk-ant-api03"],
  ["maps key AIza" + "D".repeat(35), "AIza"],
  ["-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nabc\n-----END RSA PRIVATE KEY-----", "MIIEow"],
  ["token sk%5Flive%5F" + "e".repeat(24), "e".repeat(24)],
];

describe("scrubDocumentText (text)", () => {
  it.each(cases)("removes %s", (input, secret) => {
    const out = scrubDocumentText(`before\n${input}\nafter`);
    expect(out.text).not.toContain(secret);
    expect(out.text).toContain("before");
    expect(out.text).toContain("after");
    expect(out.count).toBeGreaterThan(0);
  });
  it("leaves ordinary business prose alone", () => {
    const prose = [
      "Keywords: growth, seo, retention",
      "The key insight is that trials convert at 22%.",
      "Key: growth",
      "Token economy is not our model.",
      "Password resets are our top support ticket (41 in Aug).",
      "Contact: founder@example.com",
      "Discount 20% off in August",
    ].join("\n");
    expect(scrubDocumentText(prose)).toEqual({ text: prose, count: 0 });
  });
  it("counts each redaction once, and is idempotent (a second pass finds nothing)", () => {
    const once = scrubDocumentText("API_KEY=sk_test_" + "e".repeat(24) + '\n{"password":"x"}');
    expect(once.count).toBe(2);
    expect(scrubDocumentText(once.text).count).toBe(0);
  });
});

describe("round-3 bypasses", () => {
  it("a credential assignment loses its WHOLE value: spaces, quotes and trailing comments", () => {
    for (const [line, secret] of [
      ["password: correct horse battery staple", "horse battery"],
      ["PASSWORD=abc # rotate monthly", "abc"],
      ['db_password = "two words" ; old', "two words"],
    ] as const) {
      const out = scrubDocumentText(line);
      expect(out.text).not.toContain(secret);
      expect(out.count).toBe(1);
    }
  });
  it("JSON: a credential key redacts its whole SUBTREE (objects and arrays)", () => {
    for (const json of ['{"api_key":{"value":"abc"}}', '{"token":["abc","def"]}']) {
      const out = scrubDocumentText(json, "json");
      expect(out.text).not.toMatch(/abc|def/);
      expect(out.count).toBe(1);
    }
  });
  it("JSON is parsed BEFORE percent-decoding (an encoded quote cannot break the structure)", () => {
    const out = scrubDocumentText('{"password": "a%22b%22c", "note": "ok"}', "json");
    expect(out.text).not.toMatch(/a"b|a%22b/);
    expect(out.text).toContain("ok");
  });
  it("CSV with a byte-order mark still finds the credential column", () => {
    const out = scrubDocumentText("\uFEFFname,api_key\nAcme,zz9-secret", "csv");
    expect(out.text).not.toContain("zz9-secret");
    expect(out.count).toBe(1);
  });
  it("idempotent in TEXT and COUNT for every mode", () => {
    for (const [input, kind] of [
      ["password: two words # c\nAPI_KEY=sk_test_" + "e".repeat(24), "text"],
      ['{"token":["abc"],"password":"x"}', "json"],
      ["name,api_key\nA,zz", "csv"],
    ] as const) {
      const once = scrubDocumentText(input, kind);
      const twice = scrubDocumentText(once.text, kind);
      expect(twice).toEqual({ text: once.text, count: 0 });
    }
  });
});

describe("structured files", () => {
  it.each([
    ['{"password": "hunter2pass"}', "hunter2pass"],
    ['{"password": "abc"}', '"abc"'],
    ['{ "client_secret" : "generic-secret-value" }', "generic-secret-value"],
    ['{"db": {"apiKey": "sk\\u002dabcdef123456"}}', "abcdef123456"],
    ['[{"stripe_token": "tok_123"}]', "tok_123"],
  ])("JSON: every non-empty value under a credential key goes, whatever its length or escapes: %s", (input, secret) => {
    const out = scrubDocumentText(input, "json");
    expect(out.text).not.toContain(secret);
    expect(out.count).toBe(1);
  });
  it("JSON that does not parse falls back to the text rules", () => {
    const out = scrubDocumentText('{"password": "hunter2pass",', "json");
    expect(out.text).not.toContain("hunter2pass");
  });
  it("CSV: an RFC-4180 parse finds the right column past quoted commas, quotes and newlines", () => {
    const csv = 'name,note,api_key,plan\n"Acme, Inc","said ""hi""\nthen left",zz9-plural,pro\nBeta,ok,qq8,free';
    const out = scrubDocumentText(csv, "csv");
    expect(out.text).not.toContain("zz9-plural");
    expect(out.text).not.toContain("qq8");
    expect(out.text).toContain('"Acme, Inc"');
    expect(out.text).toContain("pro");
    expect(out.count).toBe(2);
  });
  it("leaves ordinary structured business data alone", () => {
    const json = '{"password_resets": 41, "token_count": 5, "keyword": "retention", "secret_sauce": "referrals", "monkey": "banana split", "key": "retention"}';
    expect(scrubDocumentText(json, "json").count).toBe(0);
    const csv = "month,signups,passwords_reset,token_count\nAug,138,41,5";
    expect(scrubDocumentText(csv, "csv")).toEqual({ text: csv, count: 0 });
  });
});

describe("Authorization headers", () => {
  it.each([
    ["Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig", "eyJhbGciOiJIUzI1NiJ9"],
    ["authorization: basic dXNlcjpwYXNz", "dXNlcjpwYXNz"],
    ["Proxy-Authorization: Basic cHJveHk6cGFzcw==", "cHJveHk6cGFzcw"],
    ['curl -H "Authorization: Bearer ghp_1234567890abcdefXYZ" https://api.example.com', "1234567890abcdef"],
    ["Authorization: Custom 9f8e7d6c5b4a39281706", "9f8e7d6c5b4a39281706"],
    ['{"headers": {"Authorization": "Bearer ghp_1234567890abcdefXYZ"}', "1234567890abcdef"],
    ['Authorization: Digest username="bob", realm="api", nonce="dcd98b", response="6629fae49393a053"', "6629fae4"],
    ["Authorization: AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260924/us-east-1/s3/aws4_request, SignedHeaders=host, Signature=fe5f80f77d5fa3beca038a248ff027", "fe5f80f7"],
  ])("text: %s", (input, secret) => {
    const out = scrubDocumentText(`before\n${input}\nafter`);
    expect(out.text).not.toContain(secret);
    expect(out.text).toContain("after");
    expect(out.count).toBe(1);
    expect(scrubDocumentText(out.text)).toEqual({ text: out.text, count: 0 });
  });
  it("JSON and CSV: the header's value goes, whatever the scheme", () => {
    const json = scrubDocumentText('{"headers": {"Authorization": "Bearer tok123", "Proxy-Authorization": "Basic cHg="}}', "json");
    expect(json.text).not.toMatch(/tok123|cHg=/);
    expect(json.count).toBe(2);
    const csv = scrubDocumentText("url,authorization\n/a,Bearer tok123", "csv");
    expect(csv.text).not.toContain("tok123");
    expect(csv.count).toBe(1);
  });
  it("leaves the ordinary word 'authorization' in prose alone", () => {
    const prose = [
      "Refunds need manager authorization before they go out.",
      "Authorization: required for refunds over $500",
      "Card authorization rates fell to 91% in August.",
      "Authorization: Basic approval from a manager is required.",
      "Authorization: Bearer of this letter may collect the refund.",
      "Authorization: Token of appreciation for early customers.",
    ].join("\n");
    expect(scrubDocumentText(prose)).toEqual({ text: prose, count: 0 });
  });
  it("a parameterized scheme loses its WHOLE value, and only up to the closing quote when quoted", () => {
    const digest = 'Authorization: Digest username="bob", realm="api", nonce="dcd98b", response="6629fae49393a053"';
    expect(scrubDocumentText(digest).text).toBe("Authorization: [redacted]");
    const aws = "Authorization: AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260924/us-east-1/s3/aws4_request, SignedHeaders=host, Signature=fe5f80f7";
    expect(scrubDocumentText(aws).text).toBe("Authorization: [redacted]");
    const curl = "curl -H 'Authorization: Digest username=\"bob\", response=\"6629fae4\"' https://api.example.com";
    const out = scrubDocumentText(curl);
    expect(out.text).toBe("curl -H 'Authorization: [redacted]' https://api.example.com");
    expect(scrubDocumentText(out.text)).toEqual({ text: out.text, count: 0 });
    const json = '{"Authorization": "Digest username=\\"bob\\", response=\\"6629fae4\\"", "note": "keep"';
    const j = scrubDocumentText(json);
    expect(j.text).not.toContain("6629fae4");
    expect(j.text).toContain('"note": "keep"');
  });
  it("Basic and Bearer credential tokens go", () => {
    for (const [line, secret] of [["Authorization: Basic dXNlcjpwYXNzd29yZA==", "dXNlcjpw"], ["Authorization: Bearer sk_live_0123456789abcdef", "0123456789"]]) {
      const out = scrubDocumentText(line);
      expect(out.text).not.toContain(secret);
      expect(out.count).toBe(1);
    }
  });
});
