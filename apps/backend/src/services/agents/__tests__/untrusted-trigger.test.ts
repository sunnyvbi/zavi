import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isUntrustedInboundTrigger,
  UNTRUSTED_INBOUND_TRIGGERS,
} from "../untrusted-trigger";
import { AGENT_TRIGGERS } from "../types";

describe("isUntrustedInboundTrigger (E1) — armed set is {email, webhook}", () => {
  it("armed for email + webhook (GitHub inbound) only", () => {
    expect(isUntrustedInboundTrigger("email")).toBe(true);
    expect(isUntrustedInboundTrigger("webhook")).toBe(true);
  });

  it("NOT armed for slack/teams (accepted-open) or any internal-origin trigger", () => {
    const notArmed = AGENT_TRIGGERS.filter(
      (t) => t !== "email" && t !== "webhook",
    );
    for (const t of notArmed) {
      expect(isUntrustedInboundTrigger(t)).toBe(false);
    }
    expect(isUntrustedInboundTrigger("slack")).toBe(false);
    expect(isUntrustedInboundTrigger("teams")).toBe(false);
  });

  it("null/undefined/unknown → false", () => {
    expect(isUntrustedInboundTrigger(null)).toBe(false);
    expect(isUntrustedInboundTrigger(undefined)).toBe(false);
    expect(isUntrustedInboundTrigger("not-a-trigger")).toBe(false);
  });

  it("the exported set is exactly {email, webhook}", () => {
    expect([...UNTRUSTED_INBOUND_TRIGGERS].sort()).toEqual(["email", "webhook"]);
  });
});

describe("kill switch — UNTRUSTED_INBOUND_TRIGGER_WIDEN", () => {
  it("=0 reverts to legacy email-only (webhook no longer armed)", () => {
    const prev = process.env.UNTRUSTED_INBOUND_TRIGGER_WIDEN;
    process.env.UNTRUSTED_INBOUND_TRIGGER_WIDEN = "0";
    try {
      expect(isUntrustedInboundTrigger("email")).toBe(true);
      expect(isUntrustedInboundTrigger("webhook")).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.UNTRUSTED_INBOUND_TRIGGER_WIDEN;
      else process.env.UNTRUSTED_INBOUND_TRIGGER_WIDEN = prev;
    }
  });

  it("unset (default) → ON (webhook armed)", () => {
    const prev = process.env.UNTRUSTED_INBOUND_TRIGGER_WIDEN;
    delete process.env.UNTRUSTED_INBOUND_TRIGGER_WIDEN;
    try {
      expect(isUntrustedInboundTrigger("webhook")).toBe(true);
    } finally {
      if (prev !== undefined) process.env.UNTRUSTED_INBOUND_TRIGGER_WIDEN = prev;
    }
  });
});

describe("source-guard — no raw `trigger === \"email\"` egress-taint literal remains", () => {
  const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
  const files = [
    "src/services/agents/generic-dispatcher.ts",
    "src/services/mcp/execute.ts",
  ];
  for (const rel of files) {
    it(`${rel} has no untrusted_inbound: ...trigger === "email" literal`, () => {
      const src = readFileSync(join(REPO_ROOT, rel), "utf8");
      const re = /untrusted_inbound:\s*[^\n,]*trigger\s*===\s*"email"/g;
      expect(src.match(re)).toBeNull();
    });
  }
});
