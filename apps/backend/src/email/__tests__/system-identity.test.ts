
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  systemSender,
  systemSenderEmail,
  DEFAULT_SYSTEM_EMAIL_FROM,
  __resetLegacyWarnForTests,
} from "../system-identity";

const ORIG = { ...process.env };

beforeEach(() => {
  __resetLegacyWarnForTests();
  delete process.env.ZAVI_EMAIL_FROM;
  delete process.env.ZAVI_EMAIL_FROM_NAME;
  delete process.env.SYSTEM_EMAIL_FROM;
});
afterEach(() => {
  process.env = { ...ORIG };
  vi.restoreAllMocks();
});

describe("systemSender — brand identity lives in code, not in a secret", () => {
  it("defaults to support@zaviagent.com with NO env set", () => {
    expect(systemSender()).toEqual({ email: "support@zaviagent.com", name: "Zavi" });
    expect(systemSenderEmail()).toBe(DEFAULT_SYSTEM_EMAIL_FROM);
  });

  it("never returns a thepraxis.ai address", () => {
    expect(systemSenderEmail()).not.toMatch(/thepraxis/i);
  });

  it("lets ZAVI_EMAIL_FROM override for staging and dev", () => {
    process.env.ZAVI_EMAIL_FROM = "staging@zaviagent.com";
    process.env.ZAVI_EMAIL_FROM_NAME = "Zavi Staging";
    expect(systemSender()).toEqual({ email: "staging@zaviagent.com", name: "Zavi Staging" });
  });

  it("treats a blank or whitespace override as unset, not as an empty From", () => {
    process.env.ZAVI_EMAIL_FROM = "   ";
    expect(systemSenderEmail()).toBe(DEFAULT_SYSTEM_EMAIL_FROM);
  });

  it("trims a padded value rather than sending an unusable address", () => {
    process.env.ZAVI_EMAIL_FROM = "  ops@zaviagent.com \n";
    expect(systemSenderEmail()).toBe("ops@zaviagent.com");
  });

  it("IGNORES the retired SYSTEM_EMAIL_FROM, even when it is set", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.SYSTEM_EMAIL_FROM = "hello@thepraxis.ai";
    expect(systemSenderEmail()).toBe("support@zaviagent.com");
  });

  it("warns loudly that the retired var is ignored, so it is not a silent no-op", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.SYSTEM_EMAIL_FROM = "hello@thepraxis.ai";

    systemSender();

    expect(warn).toHaveBeenCalled();
    const msg = String(warn.mock.calls[0][0]);
    expect(msg).toMatch(/SYSTEM_EMAIL_FROM/);
    expect(msg).toMatch(/IGNORED/);
    expect(msg).toMatch(/ZAVI_EMAIL_FROM/);
  });

  it("warns once per process, not once per email sent", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.SYSTEM_EMAIL_FROM = "hello@thepraxis.ai";

    systemSender();
    systemSender();
    systemSender();

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("stays quiet when the retired var is absent", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    systemSender();
    expect(warn).not.toHaveBeenCalled();
  });
});
