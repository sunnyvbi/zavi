// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, within } from "@testing-library/react";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("@/lib/supabase", () => ({
  createBrowserSupabase: () => ({
    from: () => ({ select: () => ({ eq: () => ({ in: () => Promise.resolve({ data: [], error: null }) }) }) }),
  }),
}));
vi.mock("@/lib/active-tenant-client", () => ({ getActiveTenantId: () => Promise.resolve("tenant-1") }));

import { PostPreview } from "./PostPreview";

const PATH = "73db45ff-457e-4541-bc8f-bdb625390204/9ff27fce-9f83-4c1a-9a1e-0b2c3d4e5f60.jpg";
const PIN = { title: "Linen duvet cover", text: "Stonewashed linen.", image_path: PATH, board_id: "222", board_name: "Linen", link: "https://acme.com/p/duvet" };
const READINESS = {
  ok: true,
  checks: {
    board: { status: "pass" },
    media: { status: "skipped" },
    link: { status: "fail", reason_code: "pinterest_link_nopin", reason: "The page this pin links to tells Pinterest not to allow pins from it." },
    identity: { status: "unverified", reason: "Your company website is not on file, so Zavi could not confirm the link goes to your own site." },
  },
};

beforeEach(() => apiFetch.mockReset().mockResolvedValue({ ok: false, json: async () => ({}) }));
afterEach(cleanup);

describe("PostPreview — Pinterest readiness before Approve", () => {
  it("lists board, link and site checks from the stored readiness, with the reason when not passing", () => {
    const { container } = render(<PostPreview channel="pinterest_pin" payload={PIN} readiness={READINESS} />);
    const list = within(container).getByRole("list", { name: "Pinterest checks" });
    const items = within(list).getAllByRole("listitem").map((li) => li.textContent);
    expect(items).toEqual(["✓Board · Checked", "!Link · Problem", "?Your site · Not checked"]);
    expect(within(list).getAllByRole("listitem")[1].className).toContain("text-ca-danger");
    expect(within(container).getByText("Link: The page this pin links to tells Pinterest not to allow pins from it.").className).toContain("text-ca-danger");
    expect(within(container).getByText("Your site: Your company website is not on file, so Zavi could not confirm the link goes to your own site.")).toBeTruthy();
    expect(within(container).queryByText(/^Board:/)).toBeNull();
  });

  it("shows nothing when the card carries no readiness, or for another channel", () => {
    const a = render(<PostPreview channel="pinterest_pin" payload={PIN} />);
    expect(within(a.container).queryByRole("list", { name: "Pinterest checks" })).toBeNull();
    const b = render(<PostPreview channel="instagram_image" payload={{ text: "hi", image_path: PATH }} readiness={READINESS} />);
    expect(within(b.container).queryByRole("list", { name: "Pinterest checks" })).toBeNull();
  });

  it("ignores a malformed readiness instead of breaking the card", () => {
    const { container } = render(<PostPreview channel="pinterest_pin" payload={PIN} readiness={{ checks: { board: "yes", link: null } }} />);
    expect(within(container).queryByRole("list", { name: "Pinterest checks" })).toBeNull();
    expect(container.textContent).toContain("Linen duvet cover");
  });
});

describe("PostPreview — Pinterest pin card", () => {
  it("reads like a pin: image beside the title, plain-language footer, no counters while not editing", async () => {
    apiFetch.mockReset().mockImplementation(async (url: string) =>
      String(url).startsWith("/api/chat/image-url") ? { ok: true, json: async () => ({ signed_url: "https://img.example/pin.jpg" }) } : { ok: false, json: async () => ({}) },
    );
    const { container } = render(<PostPreview channel="pinterest_pin" payload={PIN} readiness={READINESS} />);
    const img = (await within(container).findByRole("img", { name: "Pin image: Linen duvet cover" })) as HTMLImageElement;
    expect(img.src).toBe("https://img.example/pin.jpg");
    expect(img.className).toContain("aspect-[2/3]");
    expect(within(container).getByText("Linen duvet cover").className).toContain("text-[16px]");
    expect(within(container).getByText(/Posts to Pinterest/).textContent).toMatch(/when you approve$/);
    expect(within(container).queryByText(/Staged for your approval/)).toBeNull();
    expect(container.textContent).not.toMatch(/\d+ \/ \d+/);
  });

  it("puts the description counter right under the box while editing a pin, above the links and checks", () => {
    const { container } = render(
      <PostPreview channel="pinterest_pin" payload={PIN} readiness={READINESS} chrome={false} onEdit={() => {}} />,
    );
    const box = within(container).getByRole("textbox", { name: "Post text" });
    const counter = within(container).getByText(`${PIN.text.length} / 500`);
    const checks = within(container).getByRole("list", { name: "Pinterest checks" });
    expect(box.compareDocumentPosition(counter) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(counter.compareDocumentPosition(checks) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(container).getAllByText(/ \/ 500$/)).toHaveLength(1);
  });

  it("other channels keep their card as it was", () => {
    const { container } = render(<PostPreview channel="instagram_image" payload={{ text: "hi", image_path: PATH }} />);
    expect(within(container).getByText("Publishes when you approve")).toBeTruthy();
    expect(within(container).queryByText(/Posts to Pinterest/)).toBeNull();
  });

  it("keeps a future publication time visible when the surrounding card supplies the chrome", () => {
    const { container } = render(
      <PostPreview
        channel="pinterest_pin"
        payload={PIN}
        scheduledAt="2099-01-02T09:30:00.000Z"
        chrome={false}
      />,
    );
    expect(within(container).getByText(/Posts to Pinterest .*once you approve/)).toBeTruthy();
  });
});
