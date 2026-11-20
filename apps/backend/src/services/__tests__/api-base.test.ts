import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

vi.mock("@/services/supabase", () => ({ serviceClient: () => ({}) }));

import { publicApiBaseUrl, resetApiBaseWarningForTests } from "../api-base";
import { unsubscribeUrl, unsubscribeHeaders } from "@/services/tools/email/safety-net";

const TOKEN = "11111111-1111-4111-8111-111111111111";

function stubAll(env: Record<string, string>): void {
  for (const k of ["NODE_ENV", "PUBLIC_API_URL", "BACKEND_PUBLIC_URL", "PORT"]) vi.stubEnv(k, env[k] ?? "");
}

beforeEach(() => {
  resetApiBaseWarningForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("unsubscribe links outside production never point at production", () => {
  it("local dev with nothing set points at the local backend port, not api.zaviagent.com", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    stubAll({ NODE_ENV: "development", PORT: "3011" });
    const url = unsubscribeUrl(TOKEN);
    expect(url).toBe(`http://localhost:3011/api/email/unsubscribe?token=${TOKEN}`);
    expect(url).not.toContain("zaviagent.com");
    expect(unsubscribeHeaders(TOKEN)["List-Unsubscribe"]).toBe(`<http://localhost:3011/api/email/unsubscribe?token=${TOKEN}>`);
  });

  it("an unset NODE_ENV is not production", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    stubAll({});
    expect(unsubscribeUrl(TOKEN)).toBe(`http://localhost:3001/api/email/unsubscribe?token=${TOKEN}`);
  });

  it("staging with only BACKEND_PUBLIC_URL set uses it, even under NODE_ENV=production", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubAll({ NODE_ENV: "production", BACKEND_PUBLIC_URL: "https://api-staging.example.com/" });
    expect(unsubscribeUrl(TOKEN)).toBe(`https://api-staging.example.com/api/email/unsubscribe?token=${TOKEN}`);
    expect(warn).not.toHaveBeenCalled();
  });

  it("PUBLIC_API_URL wins over BACKEND_PUBLIC_URL and loses its trailing slashes", () => {
    stubAll({ NODE_ENV: "development", PUBLIC_API_URL: " http://localhost:4444// ", BACKEND_PUBLIC_URL: "http://localhost:9999" });
    expect(publicApiBaseUrl()).toBe("http://localhost:4444");
  });

  it("production with nothing set keeps the production API and does not warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubAll({ NODE_ENV: "production" });
    expect(unsubscribeUrl(TOKEN)).toBe(`https://api.zaviagent.com/api/email/unsubscribe?token=${TOKEN}`);
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns once, naming both variables, across many sends", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubAll({ NODE_ENV: "test" });
    for (let i = 0; i < 5; i++) unsubscribeUrl(TOKEN);
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0][0]);
    expect(msg).toContain("PUBLIC_API_URL");
    expect(msg).toContain("BACKEND_PUBLIC_URL");
    expect(msg).toContain("http://localhost:3001");
  });

  it("a whitespace-only value counts as unset", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    stubAll({ NODE_ENV: "development", PUBLIC_API_URL: "   ", BACKEND_PUBLIC_URL: " " });
    expect(publicApiBaseUrl()).toBe("http://localhost:3001");
  });
});
