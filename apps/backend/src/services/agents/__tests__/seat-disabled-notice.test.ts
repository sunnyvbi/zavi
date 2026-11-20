
import { describe, it, expect } from "vitest";
import {
  isInfraRetryable,
  isProviderAuthError,
  isProviderSeatDisabledNotice,
} from "../infra-retry";
import { chatFailureBubbleBody, synthesizeErrorBody } from "../error-body";

const ORG_DISABLED =
  "Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access";
const NO_ACCESS =
  "Your account does not have access to Claude. Please login again or contact your administrator.";
const WRAPPED_NO_ACCESS = `Claude Code returned an error result: ${NO_ACCESS}`;

describe("isProviderSeatDisabledNotice — TIGHT standalone classifier", () => {
  it("matches the real provider entitlement notices", () => {
    expect(isProviderSeatDisabledNotice(ORG_DISABLED)).toBe(true);
    expect(isProviderSeatDisabledNotice(NO_ACCESS)).toBe(true);
    expect(isProviderSeatDisabledNotice(`\n  ${ORG_DISABLED}  \n`)).toBe(true);
  });

  it("does NOT match prose that merely mentions these topics", () => {
    expect(
      isProviderSeatDisabledNotice(
        `I hit an upstream error: ${ORG_DISABLED} — retrying later.`,
      ),
    ).toBe(false);
    expect(
      isProviderSeatDisabledNotice(
        "Your organization has disabled SSO — ask your admin to re-enable it.",
      ),
    ).toBe(false);
    expect(
      isProviderSeatDisabledNotice(`${ORG_DISABLED} ${"x".repeat(300)}`),
    ).toBe(false);
    expect(isProviderSeatDisabledNotice(null)).toBe(false);
    expect(isProviderSeatDisabledNotice("")).toBe(false);
  });
});

describe("isProviderAuthError — entitlement notices classify as seat auth", () => {
  it("matches both notices, bare and wrapped", () => {
    expect(isProviderAuthError(ORG_DISABLED)).toBe(true);
    expect(isProviderAuthError(NO_ACCESS)).toBe(true);
    expect(isProviderAuthError(WRAPPED_NO_ACCESS)).toBe(true);
  });
});

describe("error-body — clean customer bubble, no provider jargon", () => {
  it.each([
    ["bare org-disabled", ORG_DISABLED],
    ["bare no-access", NO_ACCESS],
    ["wrapped no-access", WRAPPED_NO_ACCESS],
  ])("renders the honest seat copy for %s", (_label, raw) => {
    const body = chatFailureBubbleBody(raw, "operator");
    expect(body).toContain("on our side");
    for (const leak of [
      "Anthropic",
      "API key",
      "Claude Code",
      "subscription",
      "admin",
      "administrator",
    ]) {
      expect(body).not.toContain(leak);
    }
    expect(synthesizeErrorBody(raw, "operator").action_link).toBeNull();
  });

  it("a CUSTOMER connector's auth expiry keeps its Reconnect button", () => {
    const r = synthesizeErrorBody(
      '{"error":"google_ads_auth_expired","message":"OAuth token has expired"}',
      "performance-marketer",
    );
    expect(r.action_link).toBe(
      "[Reconnect Google Ads](/__praxis_action__/reauth:google_ads)",
    );
  });
});

describe("isInfraRetryable — a disabled seat surfaces now, no re-fire loop", () => {
  it("does not infra-retry the entitlement notice, bare or wrapped", () => {
    expect(isInfraRetryable("dispatch_error", ORG_DISABLED)).toBe(false);
    expect(isInfraRetryable("dispatch_error", WRAPPED_NO_ACCESS)).toBe(false);
  });
  it("still infra-retries an ordinary seat 401", () => {
    expect(
      isInfraRetryable(
        "dispatch_error",
        "Claude Code returned an error result: API Error: 401",
      ),
    ).toBe(true);
  });
});
