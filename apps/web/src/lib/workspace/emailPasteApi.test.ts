import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));

import { pasteEmail, PasteEmailError } from "./emailPasteApi";

const input = { route: "sendgrid" as const, list_id: "list-1", pasted: { subject: "Hello", body: "Our news, in our words. https://example.test" } };

beforeEach(() => {
  apiFetch.mockReset();
});

describe("pasteEmail", () => {
  it("posts the paste once with an idempotency key and returns the card to open", async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, card: { rail: "channel_actions", id: "c1" }, link: "/workspace/email-cards/channel_actions/c1", route: "sendgrid", versions: 1 }),
    });
    await expect(pasteEmail(input)).resolves.toEqual({ ok: true, card: { rail: "channel_actions", id: "c1" }, link: "/workspace/email-cards/channel_actions/c1", route: "sendgrid", versions: 1 });
    expect(apiFetch).toHaveBeenCalledTimes(1);
    const [path, init] = apiFetch.mock.calls[0];
    expect(path).toBe("/api/email-cards/paste");
    expect(init).toMatchObject({ method: "POST", idempotent: true });
    expect(JSON.parse(init.body)).toEqual({ inputs: input });
  });

  it("sends the caller's request id as the Idempotency-Key so a retry replays instead of filing again", async () => {
    apiFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, card: { rail: "channel_actions", id: "c1" }, link: "/x", route: "sendgrid", versions: 1 }) });
    await pasteEmail(input, "paste-req-12345678");
    await pasteEmail(input, "paste-req-12345678");
    expect(apiFetch.mock.calls.map(([, init]) => init.headers?.["Idempotency-Key"])).toEqual(["paste-req-12345678", "paste-req-12345678"]);
    expect(apiFetch.mock.calls[0][1]).toMatchObject({ idempotent: true });
  });

  it("carries the server's refusal, code and required plan", async () => {
    apiFetch.mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: { code: "plan_upgrade_required", required_tier: "pro", message: "Email campaigns needs the Pro plan ($240/mo)." } }) });
    const e = (await pasteEmail(input).catch((x: unknown) => x)) as PasteEmailError;
    expect(e).toBeInstanceOf(PasteEmailError);
    expect(e).toMatchObject({ code: "plan_upgrade_required", status: 403, requiredTier: "pro", message: "Email campaigns needs the Pro plan ($240/mo)." });
  });

  it("never reports a card the server did not return", async () => {
    apiFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) });
    await expect(pasteEmail(input)).rejects.toBeInstanceOf(PasteEmailError);
  });

  it("says Zavi could not be reached when the request never answers", async () => {
    apiFetch.mockImplementation(() => {
      throw new TypeError("Failed to fetch");
    });
    let e: unknown = null;
    try {
      await pasteEmail(input);
    } catch (x) {
      e = x;
    }
    expect(e).toBeInstanceOf(PasteEmailError);
    expect((e as PasteEmailError).code).toBe("network");
    expect((e as PasteEmailError).status).toBe(0);
  });
});
