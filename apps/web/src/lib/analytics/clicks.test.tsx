// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://www.zaviagent.com/"}

import { cleanup, render } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("@/lib/analytics/events", () => ({ trackEvent: h.track }));

import { ClickTracking, clickLabel, clickTarget } from "./clicks";

function page(path: string, html: string) {
  window.history.replaceState(null, "", path);
  document.body.innerHTML = html;
  render(<ClickTracking />);
}

document.addEventListener("click", (e) => e.preventDefault());

function click(selector: string) {
  document
    .querySelector(selector)!
    .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

describe("click tracking on public pages", () => {
  beforeEach(() => h.track.mockReset());
  afterEach(() => cleanup());

  it("records a CTA click on a marketing page with its label and destination", () => {
    page("/pricing", '<a id="go" href="/start?plan=starter"><span>Start  free</span></a>');
    click("#go span");
    expect(h.track).toHaveBeenCalledWith("cta_clicked", {
      page_type: "pricing",
      path: "/pricing",
      element: "link",
      target: "/start",
      label: "Start free",
    });
  });

  it("sends only the destination on a share page", () => {
    page("/live/acme", '<a id="go" href="https://acme.com/x?y=1">Acme site</a>');
    click("#go");
    expect(h.track).toHaveBeenCalledWith(
      "cta_clicked",
      expect.objectContaining({ page_type: "live_report", target: "acme.com", label: undefined }),
    );
  });

  it("leaves onboarding pages and the signed-in app to their own events", () => {
    page("/start", '<button id="b">Continue</button>');
    click("#b");
    page("/workspace", '<button id="b">Send</button>');
    click("#b");
    expect(h.track).not.toHaveBeenCalled();
  });

  it("ignores the cookie banner", () => {
    page("/", '<section data-analytics-ignore><button id="r">Reject</button></section>');
    click("#r");
    expect(h.track).not.toHaveBeenCalled();
  });

  it("keeps server and first client markup identical", () => {
    const element = <ClickTracking />;
    const server = renderToString(element);
    expect(render(element).container.innerHTML).toBe(server);
  });
});

describe("helpers", () => {
  it("clickTarget keeps safe campaign tags and only the host of another site", () => {
    const o = "https://www.zaviagent.com";
    expect(clickTarget("/tools?use=deck&utm_source=news", o)).toBe("/tools?utm_source=news");
    expect(clickTarget("https://x.com/zavi?ref=1", o)).toBe("x.com");
    expect(clickTarget("/invite/beta?key=secret", o)).toBe("/invite/beta");
    expect(clickTarget("/reset-password/secret", o)).toBe("/reset-password");
    expect(clickTarget("mailto:private@example.com", o)).toBe("");
    expect(clickTarget("javascript:alert('secret')", o)).toBe("");
  });

  it("clickLabel prefers data-analytics, then aria-label, then text", () => {
    const el = document.createElement("button");
    el.textContent = "  Book   a call ";
    expect(clickLabel(el)).toBe("Book a call");
    el.setAttribute("aria-label", "Open menu");
    expect(clickLabel(el)).toBe("Open menu");
    el.setAttribute("data-analytics", "hero_cta");
    expect(clickLabel(el)).toBe("hero_cta");
  });
});
