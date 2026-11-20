import { describe, it, expect, vi, beforeEach } from "vitest";
const exec = vi.hoisted(() => vi.fn());
vi.mock("@/services/connectors/composio/api", () => ({ composioExecuteTool: exec }));
import { SOCIAL_LIMITS } from "@zavi/shared";
import { publishPinterestPinViaComposio } from "../publish";

const ACCOUNT = { tenant_id: "T1", toolkit: "pinterest", connected_account_id: "ca_pin" } as any;
const PIN = { board_id: "971159175836868903", title: "Linen duvet cover", description: "Stonewashed linen.", link: "https://acme.com/p/duvet", alt_text: "A made bed" };

beforeEach(() => exec.mockReset());

describe("publishPinterestPinViaComposio", () => {
  it("calls PINTEREST_CREATE_PIN for the verified account with the signed image URL", async () => {
    exec.mockResolvedValue({ ok: true, status: 200, data: { id: "pin1" }, error: null });
    const r = await publishPinterestPinViaComposio(ACCOUNT, PIN, "https://signed/i.jpg");
    expect(exec).toHaveBeenCalledWith({
      tool_slug: "PINTEREST_CREATE_PIN", user_id: "T1", connected_account_id: "ca_pin",
      arguments: {
        board_id: PIN.board_id, title: PIN.title, description: PIN.description, link: PIN.link, alt_text: PIN.alt_text,
        media_source: { source_type: "image_url", url: "https://signed/i.jpg" },
      },
    }, expect.any(AbortSignal));
    expect(r).toEqual({ ok: true, status: 200, raw: { id: "pin1", url: "https://www.pinterest.com/pin/pin1/" } });
  });
  it("a Pinterest refusal (e.g. no Standard access) is a stable vendor rejection", async () => {
    exec.mockResolvedValue({ ok: false, status: 403, data: null, error: "Trial access cannot create pins" });
    const r = await publishPinterestPinViaComposio(ACCOUNT, PIN, "https://s/i.jpg");
    expect(r).toEqual({ ok: false, status: 400, raw: { error: "Trial access cannot create pins" } });
  });
  it("a success with no pin id is never recorded as published, and reads as unconfirmed, not rejected", async () => {
    exec.mockResolvedValue({ ok: true, status: 200, data: { code: 2, message: "Board not found" }, error: null });
    const r = await publishPinterestPinViaComposio(ACCOUNT, PIN, "https://s/i.jpg");
    expect(r.ok).toBe(false);
    expect(r.status).toBe(0);
  });
  it("a CREATE_PIN that never answers ends as an unconfirmed outcome and cancels the call", async () => {
    let seen: AbortSignal | undefined;
    exec.mockImplementationOnce((_a: unknown, signal?: AbortSignal) => { seen = signal; return new Promise(() => {}); });
    const started = Date.now();
    const r = await publishPinterestPinViaComposio(ACCOUNT, PIN, "https://s/i.jpg", 40);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(r).toEqual({ ok: false, status: 0, raw: { error: "composio_timeout" } });
    expect(seen?.aborted).toBe(true);
  });
  it("reads the pin id from Composio's response_data wrapper", async () => {
    exec.mockResolvedValue({ ok: true, status: 200, data: { response_data: { id: "pin9" } }, error: null });
    const r = await publishPinterestPinViaComposio(ACCOUNT, PIN, "https://s/i.jpg");
    expect(r).toEqual({ ok: true, status: 200, raw: { id: "pin9", url: "https://www.pinterest.com/pin/pin9/" } });
  });
  it("reads the pin id from a JSON-encoded success body", async () => {
    exec.mockResolvedValue({ ok: true, status: 200, data: JSON.stringify({ response_data: JSON.stringify({ id: "pin7" }) }), error: null });
    const r = await publishPinterestPinViaComposio(ACCOUNT, PIN, "https://s/i.jpg");
    expect(r).toEqual({ ok: true, status: 200, raw: { id: "pin7", url: "https://www.pinterest.com/pin/pin7/" } });
  });
  it("cuts a 600-character description to the shared 500 limit, not Pinterest's API 800", async () => {
    exec.mockResolvedValue({ ok: true, status: 200, data: { id: "pin1" }, error: null });
    const long = "a".repeat(450) + "B".repeat(150);
    await publishPinterestPinViaComposio(ACCOUNT, { ...PIN, description: long, title: "t".repeat(150) }, "https://s/i.jpg");
    const args = exec.mock.calls[0][0].arguments;
    expect(SOCIAL_LIMITS.pinterest_pin.text).toBe(500);
    expect(args.description).toHaveLength(500);
    expect(args.description).toBe(long.slice(0, 500));
    expect(args.title).toHaveLength(100);
  });
  it("a transport failure keeps status 0 (retryable), never throws", async () => {
    exec.mockResolvedValue({ ok: false, status: 0, data: null, error: "composio_transport_error" });
    const r = await publishPinterestPinViaComposio(ACCOUNT, PIN, "https://s/i.jpg");
    expect(r).toEqual({ ok: false, status: 0, raw: { error: "composio_transport_error" } });
  });
});
