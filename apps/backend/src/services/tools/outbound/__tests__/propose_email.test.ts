import { describe, it, expect, vi, beforeEach } from "vitest";

const { enabledMock, getSecretMock, resolveAccountMock } = vi.hoisted(() => ({
  enabledMock: vi.fn(),
  getSecretMock: vi.fn(),
  resolveAccountMock: vi.fn(),
}));
vi.mock("../_flag-check", () => ({
  isOutboundEmailProducerEnabled: enabledMock,
}));
vi.mock("@/services/secrets/vault", () => ({ getSecret: getSecretMock }));
vi.mock("@/services/connectors/composio/account", () => ({
  resolveOwnedComposioAccount: resolveAccountMock,
}));

import { proposeOutboundEmailTool } from "../propose_email";
import { ExpectedToolError } from "@/services/tools/types";

function ctx(opts: { tenant_id?: string; withEmit?: boolean } = {}) {
  const emit = vi.fn(async () => "dec-123");
  return {
    c: {
      tenant_id: opts.tenant_id ?? "t1",
      ...(opts.withEmit === false ? {} : { emit_decision: emit }),
    } as never,
    emit,
  };
}

const goodInput = {
  to: "parent@example.com",
  subject: "Your trial lesson",
  body_text: "Hi — here is the link to book your trial.",
};

const gmailAccount = { tenant_id: "t1", toolkit: "gmail", connected_account_id: "ca_g", auth_config_id: "ac_g" };

beforeEach(() => {
  enabledMock.mockReset();
  getSecretMock.mockReset().mockResolvedValue(null);
  resolveAccountMock.mockReset().mockResolvedValue(gmailAccount);
});

describe("outbound__propose_email", () => {
  it("refuses (no emit) when the producer is disabled / tenant not allowlisted", async () => {
    enabledMock.mockResolvedValue(false);
    const { c, emit } = ctx();
    await expect(
      proposeOutboundEmailTool.execute(c, goodInput),
    ).rejects.toMatchObject({ code: "outbound_email_producer_disabled" });
    expect(emit).not.toHaveBeenCalled();
  });

  it("refuses when emit_decision is unavailable (called outside a managed run)", async () => {
    enabledMock.mockResolvedValue(true);
    const { c } = ctx({ withEmit: false });
    await expect(
      proposeOutboundEmailTool.execute(c, goodInput),
    ).rejects.toBeInstanceOf(ExpectedToolError);
  });

  it("emits ONE approval-gated outbound.send with the email body when enabled", async () => {
    enabledMock.mockResolvedValue(true);
    const { c, emit } = ctx();
    const res = await proposeOutboundEmailTool.execute(c, goodInput);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith("outbound.send", {
      channel: "email",
      to: "parent@example.com",
      subject: "Your trial lesson",
      body_text: "Hi — here is the link to book your trial.",
    });
    expect(res).toEqual({
      decision_id: "dec-123",
      decision_class: "outbound.send",
      to: "parent@example.com",
      sends_from: "gmail",
    });
  });

  it("passes through optional body_html + rationale", async () => {
    enabledMock.mockResolvedValue(true);
    const { c, emit } = ctx();
    await proposeOutboundEmailTool.execute(c, {
      ...goodInput,
      body_html: "<p>hi</p>",
      rationale: "founder asked",
    });
    expect(emit).toHaveBeenCalledWith(
      "outbound.send",
      expect.objectContaining({ body_html: "<p>hi</p>", rationale: "founder asked" }),
    );
  });

  it("input schema rejects a non-email recipient (no invented/garbage address)", () => {
    const parsed = proposeOutboundEmailTool.input_schema.safeParse({
      ...goodInput,
      to: "not-an-email",
    });
    expect(parsed.success).toBe(false);
  });
});

describe("outbound__propose_email only proposes a send when a sender is connected", () => {
  it("refuses with no connected sender and records no decision, so nothing pretends it will be sent", async () => {
    enabledMock.mockResolvedValue(true);
    resolveAccountMock.mockResolvedValue(null);
    const { c, emit } = ctx();
    const err = await proposeOutboundEmailTool.execute(c, goodInput).catch((e: Error) => e);
    expect(err).toBeInstanceOf(ExpectedToolError);
    expect((err as ExpectedToolError).code).toBe("no_email_sender");
    expect((err as Error).message).toMatch(/draft/);
    expect((err as Error).message).toMatch(/connect Gmail/);
    expect(emit).not.toHaveBeenCalled();
  });

  it("refuses when the sender check itself fails, rather than emitting a card that may never send", async () => {
    enabledMock.mockResolvedValue(true);
    resolveAccountMock.mockRejectedValue(new Error("composio HTTP 503"));
    const { c, emit } = ctx();
    await expect(proposeOutboundEmailTool.execute(c, goodInput)).rejects.toMatchObject({ code: "email_sender_unreadable" });
    expect(emit).not.toHaveBeenCalled();
  });

  it.each([
    ["the vault read fails", () => getSecretMock.mockRejectedValue(new Error("vault timeout"))],
    ["the Composio read fails", () => resolveAccountMock.mockRejectedValue(new Error("composio HTTP 503"))],
  ])("%s: never tells the model to ask the founder to connect Gmail", async (_label, arrange) => {
    enabledMock.mockResolvedValue(true);
    arrange();
    const { c, emit } = ctx();
    const err = await proposeOutboundEmailTool.execute(c, goodInput).catch((e: Error) => e);
    expect(err).toBeInstanceOf(ExpectedToolError);
    expect((err as ExpectedToolError).code).toBe("email_sender_unreadable");
    expect((err as Error).message).not.toMatch(/connect Gmail|No email account is connected/);
    expect((err as Error).message).toMatch(/try again/i);
    expect(emit).not.toHaveBeenCalled();
  });

  it("checks the sender for the run's own tenant", async () => {
    enabledMock.mockResolvedValue(true);
    const { c } = ctx({ tenant_id: "t-run" });
    await proposeOutboundEmailTool.execute(c, goodInput);
    expect(getSecretMock).toHaveBeenCalledWith("t-run", "email.api_key");
    expect(resolveAccountMock).toHaveBeenCalledWith("t-run", "gmail");
  });

  it("names SendGrid as the sender when a key is stored, without asking Composio", async () => {
    enabledMock.mockResolvedValue(true);
    getSecretMock.mockResolvedValue("SG.key");
    const { c, emit } = ctx();
    const res = await proposeOutboundEmailTool.execute(c, goodInput);
    expect(res.sends_from).toBe("sendgrid");
    expect(resolveAccountMock).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledTimes(1);
  });
});
