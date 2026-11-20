// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { useLayoutEffect, type ReactNode } from "react";
import { StartWebsiteStep } from "./StartWebsiteStep";
import { GrowthStartIntake } from "./GrowthStartIntake";
import { websiteHost } from "./websiteHost";

afterEach(cleanup);

const props = { website: "acme.com", onWebsiteChange: () => {}, onContinue: () => {}, error: null };

function FirstClientRender({ capture, children }: { capture: () => void; children: ReactNode }) {
  useLayoutEffect(capture, [capture]);
  return children;
}

describe("website entry", () => {
  it.each(["", "youtube", "youtube.c", "you tube", "ftp://youtube.com", "https://user:secret@example.com", "127.0.0.1", "https://-acme.com"])("does not load or submit invalid input %s", (website) => {
    const onContinue = vi.fn();
    const view = render(<GrowthStartIntake {...props} website={website} onContinue={onContinue} />);
    expect(view.container.querySelector("img")).toBeNull();
    expect((screen.getByRole("button", { name: "Start" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(screen.getByRole("textbox").closest("form")!);
    expect(onContinue).not.toHaveBeenCalled();
  });

  it("supports native keyboard form submission", () => {
    const onContinue = vi.fn();
    render(<GrowthStartIntake {...props} onContinue={onContinue} />);
    fireEvent.submit(screen.getByRole("textbox").closest("form")!);
    expect(onContinue).toHaveBeenCalledOnce();
  });

  it("announces server errors and associates them with the field", () => {
    render(<GrowthStartIntake {...props} error="Try again" />);
    expect(screen.getByRole("alert").textContent).toBe("Try again");
    expect(screen.getByRole("textbox").getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("textbox").getAttribute("aria-describedby")).toContain("start-website-error");
  });

  it("hydrates the complete screen without changing the first render", async () => {
    const container = document.createElement("div");
    container.innerHTML = renderToString(<StartWebsiteStep {...props} />);
    document.body.appendChild(container);
    const before = container.innerHTML;
    let firstClientRender = "";
    const onRecoverableError = vi.fn();
    let root: ReturnType<typeof hydrateRoot> | undefined;
    await act(async () => {
      root = hydrateRoot(container, (
        <FirstClientRender capture={() => { firstClientRender = container.innerHTML; }}>
          <StartWebsiteStep {...props} />
        </FirstClientRender>
      ), { onRecoverableError });
    });
    expect(firstClientRender).toBe(before);
    expect(onRecoverableError).not.toHaveBeenCalled();
    await act(async () => { root?.unmount(); });
    container.remove();
  });

  it("provides a reduced-motion fallback and a responsive illustration", () => {
    render(<StartWebsiteStep {...props} />);
    const panel = screen.getByRole("complementary", { name: "Why Zavi needs your website" });
    expect(panel.className).toContain("hidden");
    expect(panel.className).toContain("lg:block");
    expect(panel.querySelectorAll("li")).toHaveLength(4);
    for (const tile of panel.querySelectorAll("li")) expect(tile.className).toContain("motion-reduce:opacity-100");
  });

  it("uses the shared chat mascot and its public animation assets", () => {
    render(<StartWebsiteStep {...props} />);
    const panel = screen.getByRole("complementary", { name: "Why Zavi needs your website" });
    const mascot = panel.querySelector('[data-testid="zavi-mascot"]');
    expect(mascot).not.toBeNull();
    expect(mascot?.querySelector("video")?.getAttribute("poster")).toContain("/mascots/video/zavi-still.webp");
    expect(mascot?.querySelector('source[type="video/webm"]')?.getAttribute("src")).toContain("/mascots/video/zavi-idle.webm");
    expect(panel.querySelector('img[src^="/onboarding/"]')).toBeNull();
  });
});

describe("websiteHost", () => {
  it.each([
    ["acme.com", "acme.com"],
    [" https://WWW.Acme.com/path?q=1 ", "acme.com"],
    ["http://shop.acme.co.uk", "shop.acme.co.uk"],
    ["acme.com,", null],
    ["https://acme..com", null],
    ["https://acme-.com", null],
    ["javascript:alert(1)", null],
  ])("normalizes %s to %s", (input, expected) => expect(websiteHost(input!)).toBe(expected));
});
