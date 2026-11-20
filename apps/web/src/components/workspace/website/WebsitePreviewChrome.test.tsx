// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { WebsitePreview } from "./WebsitePreview";

vi.mock("@/lib/api", () => ({ apiFetch: () => Promise.resolve({ ok: true, json: async () => ({}) }) }));
vi.mock("@/lib/workspace/useAppReadiness", () => ({ useAppReadiness: () => ({ state: "ready", retry: () => {} }) }));

afterEach(cleanup);

function chrome(container: HTMLElement): HTMLElement {
  const bar = container.querySelector("[data-testid='preview-chrome']");
  if (!bar) throw new Error("no browser chrome rendered");
  return bar as HTMLElement;
}

function groupHolding(bar: HTMLElement, node: Element): Element {
  const group = Array.from(bar.children).find((c) => c.contains(node));
  if (!group) throw new Error("node is not inside the chrome");
  return group;
}

const url = "https://my-shop.zaviagent.com";

describe("the preview chrome", () => {
  it("keeps the device, route and open-in-a-new-page controls in ONE centre group", () => {
    const { container } = render(
      <WebsitePreview liveUrl={url} cacheKey={null} appId="my-shop.zaviagent.com" />,
    );
    const bar = chrome(container);
    const reload = screen.getByLabelText("Reload preview");
    const centre = groupHolding(bar, reload);
    expect(centre.contains(screen.getByLabelText(/^Preview width/))).toBe(true);
    expect(centre.contains(screen.getByLabelText("Open in a new page"))).toBe(true);
  });

  it("names nothing at the far left — that is the chat panel's job", () => {
    const { container } = render(
      <WebsitePreview liveUrl={url} cacheKey={null} appId="my-shop.zaviagent.com" />,
    );
    expect(screen.queryByText("My Shop")).toBeNull();
    expect(screen.queryByText("M")).toBeNull();
    const bar = chrome(container);
    const edit = screen.getByRole("button", { name: /Edit/ });
    expect(bar.contains(edit)).toBe(true);
    const centre = groupHolding(bar, screen.getByLabelText("Reload preview"));
    expect(centre.contains(edit)).toBe(false);
    expect(
      groupHolding(bar, edit).compareDocumentPosition(centre) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("centres that group over the preview instead of parking it beside the actions", () => {
    const { container } = render(
      <WebsitePreview
        liveUrl={url}
        cacheKey={null}
        appId="my-shop.zaviagent.com"
        narrowLeading={<button type="button" aria-label="Back to chat" />}
        headerActions={<button type="button">Publish</button>}
      />,
    );
    const bar = chrome(container);
    expect(bar.className).toContain("grid-cols-[1fr_minmax(0,320px)_1fr]");
    expect(bar.children.length).toBe(3);

    const centre = groupHolding(bar, screen.getByLabelText("Reload preview"));
    expect(centre).toBe(bar.children[1]);
    expect(centre.className).toContain("justify-center");
    expect(centre.className).not.toContain("justify-end");
    expect(centre.className).not.toContain("flex-1");

    expect(bar.children[0].contains(screen.getByLabelText("Back to chat"))).toBe(true);
    expect(bar.children[2].contains(screen.getByText("Publish"))).toBe(true);
  });

  it("keeps equal-width controls either side of the address pill so it reads centred", () => {
    const { container } = render(
      <WebsitePreview liveUrl={url} cacheKey={null} appId="my-shop.zaviagent.com" />,
    );
    const centre = groupHolding(chrome(container), screen.getByLabelText("Reload preview"));
    const device = screen.getByLabelText(/^Preview width/);
    const open = screen.getByLabelText("Open in a new page");
    const kids = Array.from(centre.children);
    expect(kids.findIndex((k) => k.contains(device))).toBe(0);
    expect(kids.findIndex((k) => k.contains(open))).toBe(kids.length - 1);
    expect(device.className).toContain("w-8");
    expect(open.className).toContain("w-8");
  });

  it("heads the trailing cluster with the pane toggle, ahead of the app's own actions", () => {
    const { container } = render(
      <WebsitePreview
        liveUrl={url}
        cacheKey={null}
        appId="my-shop.zaviagent.com"
        narrowTrailing={<button type="button" aria-label="Show the chat" />}
        headerActions={<button type="button">Publish</button>}
      />,
    );
    const bar = chrome(container);
    const toggle = screen.getByLabelText("Show the chat");
    const publish = screen.getByText("Publish");
    expect(bar.children[2].contains(toggle)).toBe(true);
    expect(
      toggle.compareDocumentPosition(publish) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("squares off on a phone when it owns the whole pane", () => {
    const { container } = render(
      <WebsitePreview liveUrl={url} cacheKey={null} appId="my-shop.zaviagent.com" flush />,
    );
    const shell = container.firstElementChild as HTMLElement;
    expect(shell.className).toContain("rounded-2xl");
    expect(shell.className).toContain("compact:rounded-none");
  });

  it("stays a card on the Website tab, which pads it on every side", () => {
    const { container } = render(
      <WebsitePreview liveUrl={url} cacheKey={null} appId="my-shop.zaviagent.com" />,
    );
    expect((container.firstElementChild as HTMLElement).className).not.toContain(
      "compact:rounded-none",
    );
  });

  it("lets a desktop preview use the whole stage \u2014 no width cap, no zoom", () => {
    const { container } = render(
      <WebsitePreview liveUrl={url} cacheKey={null} appId="my-shop.zaviagent.com" />,
    );
    const frame = container.querySelector("iframe") as HTMLIFrameElement;
    expect(frame.style.width).toBe("100%");
    expect(frame.getAttribute("style") ?? "").not.toContain("zoom");
    expect((frame.parentElement as HTMLElement).style.width).toBe("100%");
  });

  it("still pins tablet and mobile to their exact viewports", () => {
    const { container } = render(
      <WebsitePreview liveUrl={url} cacheKey={null} appId="my-shop.zaviagent.com" />,
    );
    const cycle = screen.getByLabelText(/^Preview width/);
    fireEvent.click(cycle);
    expect((container.querySelector("iframe") as HTMLIFrameElement).style.width).toBe("768px");
    fireEvent.click(screen.getByLabelText(/^Preview width/));
    expect((container.querySelector("iframe") as HTMLIFrameElement).style.width).toBe("425px");
  });

  it("keeps the Edit label off its own icon under width pressure", () => {
    const { container } = render(
      <WebsitePreview liveUrl={url} cacheKey={null} appId="my-shop.zaviagent.com" />,
    );
    const edit = screen.getByRole("button", { name: /^Edit/ });
    expect(edit.className).toContain("whitespace-nowrap");
    expect(edit.className).toContain("shrink-0");
    const icon = edit.querySelector("svg") as SVGElement;
    expect(icon.getAttribute("class")).toContain("shrink-0");
    expect(container.querySelector("[data-testid='preview-chrome']")!.contains(edit)).toBe(true);
  });
});

describe("a body override keeps the browser chrome", () => {
  it("renders the override where the app would be, with a pending address pill and no open-in-a-new-page link", () => {
    render(
      <WebsitePreview
        liveUrl={null}
        headerActions={<button type="button">Publish</button>}
        body={<div role="progressbar" aria-label="Website build progress" aria-valuenow={30} />}
      />,
    );
    const chrome = screen.getByTestId("preview-chrome");
    expect(chrome.contains(screen.getByRole("button", { name: "Publish" }))).toBe(true);
    expect(screen.getByTestId("preview-address-pending")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Open in a new page" })).toBeNull();
    expect(screen.getByTestId("preview-body-override").contains(screen.getByRole("progressbar"))).toBe(true);
    expect(screen.queryByRole("textbox", { name: "Route or URL" })).toBeNull();
  });
});
