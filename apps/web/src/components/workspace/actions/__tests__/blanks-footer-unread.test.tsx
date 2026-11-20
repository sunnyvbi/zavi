// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { cleanup, render, screen } from "@testing-library/react";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));

import { BlanksFill, clearBlankContextCache, useBlankFills } from "../BlanksFill";

const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));
const SETTINGS = "/api/channels/email_marketing/settings";
const TEMPLATE = "/api/workspace/email-template";
const SAVED = { template: { postal_address: "12 Saved Road, Pune" }, fonts: [], can_edit: true };

let templateDown = true;
let settingsDown = false;

beforeEach(() => {
  templateDown = true;
  settingsDown = false;
  clearBlankContextCache();
  apiFetch.mockReset();
  apiFetch.mockImplementation((path: string) => {
    if (path === TEMPLATE) return templateDown ? json({}, 500) : json(SAVED);
    if (path === SETTINGS) return settingsDown ? Promise.reject(new Error("offline")) : json({ fields: {} });
    return json({}, 404);
  });
});
afterEach(cleanup);

const flush = () => act(async () => {
  await new Promise((r) => setTimeout(r, 0));
});
const reread = async () => {
  await act(async () => {
    window.dispatchEvent(new Event("online"));
  });
  await flush();
};
const reads = (path: string) => apiFetch.mock.calls.filter(([p]) => p === path).length;

function Card({ text }: { text: string }) {
  const fills = useBlankFills([text], null, "email_marketing");
  return (
    <>
      <BlanksFill fills={fills} />
      <output data-testid="left">{fills.left}</output>
      <output data-testid="filled">{fills.fill(text)}</output>
    </>
  );
}

const CARD = "Hi there\n\n[postal address]";

describe("a copy-and-send card whose footer read failed", () => {
  it("never claims a saved address is missing, keeps Copy blocked, and fills it once a read works", async () => {
    render(<Card text={CARD} />);
    await flush();
    expect(screen.queryByTestId("blank-footer-missing")).toBeNull();
    expect(screen.getByTestId("blank-footer-unread").textContent).toBe("Could not read your footer settings. Trying again.");
    expect(document.body.textContent).not.toContain("Add your postal address");
    expect(screen.getByTestId("left").textContent).toBe("1");

    templateDown = false;
    await reread();
    expect(screen.queryByTestId("blank-footer-unread")).toBeNull();
    expect(screen.queryByTestId("blank-footer-missing")).toBeNull();
    expect(screen.getByTestId("left").textContent).toBe("0");
    expect(screen.getByTestId("filled").textContent).toContain("12 Saved Road, Pune");
  });

  it("does not keep a failed read for 30 seconds: the next card asks again and gets the address", async () => {
    const first = render(<Card text={CARD} />);
    await flush();
    expect(reads(TEMPLATE)).toBe(1);
    first.unmount();

    templateDown = false;
    render(<Card text={CARD} />);
    await flush();
    expect(reads(TEMPLATE)).toBe(2);
    expect(screen.getByTestId("left").textContent).toBe("0");
  });

  it("keeps a good read cached: a second card makes no second request", async () => {
    templateDown = false;
    const first = render(<Card text={CARD} />);
    await flush();
    first.unmount();
    render(<Card text={CARD} />);
    await flush();
    expect(reads(TEMPLATE)).toBe(1);
  });

  it("stops asking after the read works", async () => {
    render(<Card text={CARD} />);
    await flush();
    templateDown = false;
    await reread();
    const after = reads(TEMPLATE);
    await reread();
    expect(reads(TEMPLATE)).toBe(after);
  });

  it("still names a really missing address, after the read works and comes back empty", async () => {
    apiFetch.mockImplementation((path: string) => {
      if (path === TEMPLATE) return templateDown ? json({}, 500) : json({ template: { postal_address: "" }, fonts: [], can_edit: true });
      return json({ fields: {} });
    });
    render(<Card text={CARD} />);
    await flush();
    expect(screen.queryByTestId("blank-footer-missing")).toBeNull();
    templateDown = false;
    await reread();
    expect(screen.getByTestId("blank-footer-missing").getAttribute("data-source")).toBe("postal_address");
    expect(screen.queryByTestId("blank-footer-unread")).toBeNull();
  });

  it("does not trust settings alone when the template has no row and settings failed", async () => {
    templateDown = false;
    settingsDown = true;
    apiFetch.mockImplementation((path: string) => {
      if (path === TEMPLATE) return json({ template: null, fonts: [], can_edit: true });
      return settingsDown ? Promise.reject(new Error("offline")) : json({ fields: { postal_address: [{ item: "9 Settings Lane", status: "confirmed" }] } });
    });
    render(<Card text={CARD} />);
    await flush();
    expect(screen.queryByTestId("blank-footer-missing")).toBeNull();
    expect(screen.getByTestId("blank-footer-unread")).toBeTruthy();
    settingsDown = false;
    await reread();
    expect(screen.getByTestId("left").textContent).toBe("0");
    expect(screen.getByTestId("filled").textContent).toContain("9 Settings Lane");
  });
});

describe("the blanks count", () => {
  it("draws no progress bar under the count", async () => {
    templateDown = false;
    render(<Card text="[first name] and [your company]" />);
    await flush();
    expect(screen.getByTestId("blanks-left")).toBeTruthy();
    expect(screen.queryByTestId("blanks-progress")).toBeNull();
    expect(document.querySelector("[style*='width']")).toBeNull();
  });
});
