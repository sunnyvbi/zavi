import { describe, it, expect } from "vitest";
import {
  appVerifyInputSchema,
  buildAppVerifyScript,
  parseAppVerifyOutput,
  validateAppVerifyInput,
  isLoopbackHost,
  isSafeRequestPath,
  type AppVerifyInput,
} from "@/services/tools/sandbox/app-verify";

function parse(raw: Record<string, unknown>): AppVerifyInput {
  return appVerifyInputSchema.parse(raw);
}

describe("isLoopbackHost", () => {
  it("accepts loopback hosts", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
  });
  it("rejects external + metadata hosts", () => {
    expect(isLoopbackHost("example.com")).toBe(false);
    expect(isLoopbackHost("169.254.169.254")).toBe(false);
    expect(isLoopbackHost("10.0.0.5")).toBe(false);
  });
});

describe("isSafeRequestPath", () => {
  it("accepts root-relative paths", () => {
    expect(isSafeRequestPath("/")).toBe(true);
    expect(isSafeRequestPath("/api/health")).toBe(true);
    expect(isSafeRequestPath("/widgets?x=1")).toBe(true);
  });
  it("rejects host/scheme/protocol-relative/whitespace/CRLF", () => {
    expect(isSafeRequestPath("http://evil.com/")).toBe(false);
    expect(isSafeRequestPath("//evil.com/")).toBe(false);
    expect(isSafeRequestPath("api/health")).toBe(false);
    expect(isSafeRequestPath("/a b")).toBe(false);
    expect(isSafeRequestPath("/a\r\nHost: evil")).toBe(false);
  });
});

describe("validateAppVerifyInput", () => {
  it("passes a loopback + root-relative path", () => {
    expect(validateAppVerifyInput(parse({ request_path: "/api/health" }))).toBeNull();
  });
  it("refuses a non-loopback host", () => {
    const r = validateAppVerifyInput(parse({ request_path: "/x", host: "evil.com" }));
    expect(r).toMatch(/loopback/);
  });
  it("refuses an off-host request_path", () => {
    const r = validateAppVerifyInput(parse({ request_path: "http://evil.com/" }));
    expect(r).toMatch(/root-relative/);
  });
  it("refuses an off-host health_path", () => {
    const r = validateAppVerifyInput(
      parse({ request_path: "/ok", health_path: "//evil.com/" }),
    );
    expect(r).toMatch(/health_path/);
  });
});

describe("buildAppVerifyScript", () => {
  it("uses the explicit start_cmd verbatim when provided", () => {
    const s = buildAppVerifyScript(parse({ request_path: "/", start_cmd: "node server.js" }));
    expect(s).toContain("START_CMD='node server.js'");
    expect(s).not.toContain("for s in dev start server");
  });
  it("detects from package.json when start_cmd omitted", () => {
    const s = buildAppVerifyScript(parse({ request_path: "/" }));
    expect(s).toContain("for s in dev start server");
    expect(s).toContain('npm run dev');
  });
  it("targets the loopback base URL on the chosen port", () => {
    const s = buildAppVerifyScript(parse({ request_path: "/api/x", port: 8080 }));
    expect(s).toContain("http://127.0.0.1:8080/api/x");
  });
  it("polls the health_path when given, else the request_path", () => {
    const withHealth = buildAppVerifyScript(
      parse({ request_path: "/api/x", health_path: "/healthz" }),
    );
    expect(withHealth).toContain("http://127.0.0.1:3000/healthz");
    const withoutHealth = buildAppVerifyScript(parse({ request_path: "/api/x" }));
    expect(withoutHealth.match(/127\.0\.0\.1:3000\/api\/x/g)?.length).toBeGreaterThanOrEqual(2);
  });
  it("single-quotes the URL to neutralize shell metacharacters", () => {
    const s = buildAppVerifyScript(parse({ request_path: "/x?a=1&b=2" }));
    expect(s).toContain("'http://127.0.0.1:3000/x?a=1&b=2'");
  });
  it("tears the process group down (TERM then KILL)", () => {
    const s = buildAppVerifyScript(parse({ request_path: "/" }));
    expect(s).toContain('kill -TERM -"$APP_PGID"');
    expect(s).toContain('kill -KILL -"$APP_PGID"');
  });
  it("honors the boot_timeout_seconds in the poll loop", () => {
    const s = buildAppVerifyScript(parse({ request_path: "/", boot_timeout_seconds: 25 }));
    expect(s).toContain("seq 1 25");
  });
});

describe("parseAppVerifyOutput", () => {
  const input = parse({ request_path: "/api/health", expected_status: 200 });

  it("passes when booted + status matches", () => {
    const stdout =
      `__APP_VERIFY__{"booted":1,"status":"200","body_b64":""}\n----- app log tail -----\nlistening on 3000`;
    const r = parseAppVerifyOutput(stdout, input);
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
    expect(r.booted).toBe(true);
  });

  it("fails with boot_timeout when the app never became ready", () => {
    const stdout = `__APP_VERIFY__{"booted":0,"status":"","body_b64":""}\nlog`;
    const r = parseAppVerifyOutput(stdout, input);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("boot_timeout");
    expect(r.booted).toBe(false);
  });

  it("fails with status_mismatch when the status is wrong", () => {
    const stdout = `__APP_VERIFY__{"booted":1,"status":"500","body_b64":""}\nlog`;
    const r = parseAppVerifyOutput(stdout, input);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/status_mismatch_expected_200_got_500/);
    expect(r.status).toBe(500);
  });

  it("asserts body substring when expect_body_contains is set", () => {
    const body = Buffer.from('{"status":"ok"}').toString("base64");
    const inputWithBody = parse({
      request_path: "/api/health",
      expected_status: 200,
      expect_body_contains: '"status":"ok"',
    });
    const pass = parseAppVerifyOutput(
      `__APP_VERIFY__{"booted":1,"status":"200","body_b64":"${body}"}\nlog`,
      inputWithBody,
    );
    expect(pass.ok).toBe(true);
    expect(pass.body_matched).toBe(true);

    const wrongBody = Buffer.from('{"status":"error"}').toString("base64");
    const fail = parseAppVerifyOutput(
      `__APP_VERIFY__{"booted":1,"status":"200","body_b64":"${wrongBody}"}\nlog`,
      inputWithBody,
    );
    expect(fail.ok).toBe(false);
    expect(fail.reason).toBe("body_assertion_failed");
    expect(fail.body_matched).toBe(false);
  });

  it("fails with no_sentinel when the script produced no marker", () => {
    const r = parseAppVerifyOutput("some random output, no sentinel", input);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("no_sentinel");
  });

  it("truncates output_tail to the byte cap", () => {
    const big = "x".repeat(10000);
    const r = parseAppVerifyOutput(`${big}\n__APP_VERIFY__{"booted":0}`, input);
    expect((r.output_tail ?? "").length).toBeLessThanOrEqual(4096);
  });
});
