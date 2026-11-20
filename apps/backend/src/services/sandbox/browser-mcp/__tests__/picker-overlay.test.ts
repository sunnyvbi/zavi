// @vitest-environment jsdom

import { describe, it, expect, beforeAll } from "vitest";
import {
  sanitizePickedElement,
  PICKER_OVERLAY_SCRIPT,
} from "@/services/sandbox/browser-mcp/picker-overlay";

const PII = "overlay-leak.customer@example.com";

describe("sanitizePickedElement — hard whitelist", () => {
  it("keeps selector/tag/testid + structural styles; lowercases tag", () => {
    const out = sanitizePickedElement({
      selector: "#app-header > button.save",
      tag: "BUTTON",
      testid: "save-btn",
      styles: { display: "flex", fontWeight: "600", color: "rgb(0,0,0)" },
    });
    expect(out).not.toBeNull();
    expect(out!.selector).toBe("#app-header > button.save");
    expect(out!.tag).toBe("button");
    expect(out!.testid).toBe("save-btn");
    expect(out!.styles).toEqual({
      display: "flex",
      fontWeight: "600",
      color: "rgb(0,0,0)",
    });
  });

  it("drops a planted top-level PII field and unknown style keys", () => {
    const out = sanitizePickedElement({
      selector: "div.card",
      tag: "div",
      text: PII,
      innerHTML: `<b>${PII}</b>`,
      styles: { display: "block", secretEmail: PII, onclick: "steal()" },
    });
    expect(out).not.toBeNull();
    expect(out!.styles).toEqual({ display: "block" });
    expect(JSON.stringify(out)).not.toContain(PII);
  });

  it("returns null when there is no usable selector", () => {
    expect(sanitizePickedElement({ tag: "div", styles: {} })).toBeNull();
    expect(sanitizePickedElement(null)).toBeNull();
    expect(sanitizePickedElement("nope")).toBeNull();
    expect(sanitizePickedElement({ selector: "" })).toBeNull();
  });

  it("length-caps the selector and style values (bounds a blob leak)", () => {
    const out = sanitizePickedElement({
      selector: "a".repeat(5000),
      tag: "span",
      styles: { width: "b".repeat(500) },
    });
    expect(out!.selector.length).toBe(1024);
    expect(out!.styles.width.length).toBe(64);
  });

  it("ignores a non-string testid and non-string style values", () => {
    const out = sanitizePickedElement({
      selector: "button",
      testid: 42,
      styles: { display: "flex", height: { nested: PII } },
    });
    expect(out!.testid).toBeNull();
    expect(out!.styles).toEqual({ display: "flex" });
    expect(JSON.stringify(out)).not.toContain(PII);
  });
});

describe("picker overlay in a real DOM — observational only", () => {
  beforeAll(() => {
    (0, eval)(PICKER_OVERLAY_SCRIPT);
  });

  it("default OFF lets clicks through; pick-mode swallows the click and records only structure", () => {
    const host = document.createElement("div");
    host.innerHTML =
      `<form id="signup">` +
      `<input class="email" type="email" value="${PII}" />` +
      `<button id="go" class="save" data-testid="save-btn" type="submit">Welcome ${PII}</button>` +
      `</form>`;
    document.body.appendChild(host);

    const form = host.querySelector("#signup") as HTMLFormElement;
    const target = host.querySelector("#go") as HTMLButtonElement;

    let formSubmitted = false;
    let pageHandlerRan = false;
    form.addEventListener("submit", (e) => {
      formSubmitted = true;
      e.preventDefault();
    });
    target.addEventListener("click", () => {
      pageHandlerRan = true;
    });

    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(pageHandlerRan).toBe(true);

    const toggle = document.querySelector(
      '[data-praxis-picker="toggle"]',
    ) as HTMLButtonElement;
    expect(toggle).not.toBeNull();
    toggle.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    pageHandlerRan = false;
    formSubmitted = false;
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(pageHandlerRan).toBe(false);
    expect(formSubmitted).toBe(false);

    const picked = (window as unknown as { __praxis_picked?: unknown })
      .__praxis_picked as Record<string, unknown>;
    expect(picked).toBeTruthy();
    expect(typeof picked.selector).toBe("string");
    expect(picked.selector as string).toContain("#go");
    expect(picked.tag).toBe("button");
    expect(picked.testid).toBe("save-btn");
    expect(JSON.stringify(picked)).not.toContain(PII);

    expect(host.querySelector("#signup")).not.toBeNull();
    expect(host.querySelector("[data-praxis-picker]")).toBeNull();
  });
});
