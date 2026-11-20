// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { WebsitePreview } from "./WebsitePreview";
import { BUILD_PREVIEW_MIN_PX } from "../layout/buildSplit";

vi.mock("@/lib/api", () => ({ apiFetch: () => Promise.resolve({ ok: true, json: async () => ({}) }) }));

afterEach(cleanup);

const url = "https://my-shop.zaviagent.com";
const HIDE_AT = "[@container(max-width:440px)]:hidden";

function chrome(container: HTMLElement): HTMLElement {
  const bar = container.querySelector("[data-testid='preview-chrome']");
  if (!bar) throw new Error("no browser chrome rendered");
  return bar as HTMLElement;
}

function mount() {
  return render(<WebsitePreview liveUrl={url} cacheKey={null} appId="my-shop.zaviagent.com" />);
}

describe("the preview chrome as the pane narrows", () => {
  it("sizes itself against its own width, not the viewport", () => {
    const { container } = mount();
    expect(chrome(container).className).toContain("[container-type:inline-size]");
  });

  it("keeps the Edit word until the preview is nearly at its floor", () => {
    mount();
    const edit = screen.getByRole("button", { name: /Edit/ });
    const label = within(edit).getByTestId("edit-label");
    expect(label.textContent).toBe("Editing");
    expect(label.className).toContain(HIDE_AT);
    expect(edit.className).toContain("[@container(max-width:440px)]:w-8");
  });

  it("leaves the icon a real on/off toggle once the word is gone", () => {
    render(<WebsitePreview liveUrl={url} cacheKey={null} appId="my-shop.zaviagent.com" builtApp />);
    const edit = screen.getByRole("button", { name: "Edit" });
    expect(edit.getAttribute("aria-pressed")).toBe("false");
    expect(edit.getAttribute("aria-label")).toBe("Edit");
    expect(edit.getAttribute("title")).toBeNull();
    fireEvent.click(edit);
    const on = screen.getByRole("button", { name: "Editing" });
    expect(on).toBe(edit);
    expect(on.getAttribute("aria-pressed")).toBe("true");
    expect(on.getAttribute("aria-label")).toBe("Editing");
    fireEvent.click(on);
    expect(screen.getByRole("button", { name: "Edit" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("never leaves a dangling exit ✕ beside a hidden label", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: /Edit/ }));
    expect(screen.getByTestId("edit-label").className).toContain(HIDE_AT);
    expect(screen.getByTestId("edit-exit").className).toContain(HIDE_AT);
  });

  it("lets the route pill give up width instead of pushing the bar open", () => {
    const { container } = mount();
    const pill = screen.getByLabelText("Reload preview").parentElement!;
    expect(pill.className).not.toContain("w-[260px]");
    expect(pill.className).toContain("w-full");
    const wrapper = pill.parentElement!;
    expect(wrapper.className).toContain("min-w-0");
    expect(wrapper.className).toContain("w-full");
    expect(wrapper.className).not.toMatch(/(?:^|\s)w-\[\d+px\]/);
    expect(chrome(container).className).toContain("grid-cols-[1fr_minmax(0,320px)_1fr]");
  });

  it("keeps the Edit group from overflowing across the controls beside it", () => {
    const { container } = mount();
    const bar = chrome(container);
    const edit = screen.getByRole("button", { name: /Edit/ });
    const group = Array.from(bar.children).find((c) => c.contains(edit))!;
    expect(group.className).toContain("shrink-0");
    expect(group.className).not.toContain("min-w-0");
  });

  it("sheds the device toggle before the bar can run out of room", () => {
    mount();
    const device = screen.getByLabelText(/^Preview width/);
    expect(device.className).toContain("[@container(max-width:400px)]:hidden");
  });

  const EDGE = 32;
  const EDIT_ICON = 32;
  const EDIT_LABELLED = 88;
  const DEVICE = 32;
  const EXTERNAL = 32;
  const ROUTE_PILL = 96;
  const GAPS = 12 + 4 + 4 + 12;
  const ACTIONS = 152;

  it("sheds each control just before the bar would run out of room", () => {
    const full =
      EDGE + EDIT_LABELLED + DEVICE + EXTERNAL + ROUTE_PILL + GAPS + ACTIONS;
    expect(full).toBeLessThanOrEqual(480);
    expect(full - EXTERNAL).toBeLessThanOrEqual(440);
    expect(full - EXTERNAL - (EDIT_LABELLED - EDIT_ICON)).toBeLessThanOrEqual(400);
  });

  it("everything still in the bar at the preview floor fits inside it", () => {
    const atFloor =
      EDGE + EDIT_ICON + ROUTE_PILL + GAPS + ACTIONS - EXTERNAL - DEVICE;
    expect(atFloor).toBeLessThanOrEqual(BUILD_PREVIEW_MIN_PX);
  });
})
