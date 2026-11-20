
import { describe, it, expect, vi, beforeEach } from "vitest";

const answers: Record<string, "ok" | "ENOTFOUND" | "EAI_AGAIN"> = {};
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async (host: string) => {
    const a = answers[host] ?? "ENOTFOUND";
    if (a === "ok") return { address: "203.0.113.1", family: 4 };
    throw Object.assign(new Error(a), { code: a });
  }),
}));
vi.mock("@/services/auth/jwt", () => ({ verifyBearer: vi.fn() }));
vi.mock("@/services/supabase", () => ({ serviceClient: vi.fn() }));

import { domainMayExist } from "../enrich";

beforeEach(() => {
  for (const k of Object.keys(answers)) delete answers[k];
});

describe("domainMayExist", () => {
  it("is false only when apex and www both do not exist", async () => {
    expect(await domainMayExist("acme-typo.com")).toBe(false);
  });

  it("keeps a www-only site", async () => {
    answers["www.acme.com"] = "ok";
    expect(await domainMayExist("acme.com")).toBe(true);
  });

  it("treats a transient resolver error as maybe, not gone", async () => {
    answers["acme.com"] = "EAI_AGAIN";
    expect(await domainMayExist("acme.com")).toBe(true);
  });
});
