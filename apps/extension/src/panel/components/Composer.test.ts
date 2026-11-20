
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { Composer } from "./Composer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(props?: { busy?: boolean }): {
  send: HTMLButtonElement;
  type: (value: string) => void;
} {
  host = document.createElement("div");
  document.body.appendChild(host);
  const r = createRoot(host);
  root = r;
  act(() => {
    r.render(
      createElement(Composer, {
        busy: props?.busy ?? false,
        onSend: () => undefined,
      }),
    );
  });
  const el = host.querySelector("textarea") as HTMLTextAreaElement;
  return {
    send: host.querySelector('button[type="submit"]') as HTMLButtonElement,
    type: (value: string) => {
      const native = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      act(() => {
        native?.call(el, value);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      });
    },
  };
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("the send control says whether pressing it will do anything", () => {
  it("is DISABLED with an empty box", () => {
    const { send } = mount();
    expect(send).toBeTruthy();
    expect(send.disabled).toBe(true);
  });

  it("is ENABLED once there is text", () => {
    const { send, type } = mount();
    type("what is on this page?");
    expect(send.disabled).toBe(false);
  });

  it("is disabled again when the text is cleared", () => {
    const { send, type } = mount();
    type("something");
    expect(send.disabled).toBe(false);
    type("");
    expect(send.disabled).toBe(true);
  });

  it("treats whitespace as empty", () => {
    const { send, type } = mount();
    type("   \n  ");
    expect(send.disabled).toBe(true);
  });

  it("stays disabled while a send is in flight", () => {
    const { send, type } = mount({ busy: true });
    type("a follow-up");
    expect(send.disabled).toBe(true);
  });

  it("keeps an accessible name now that the label is a drawn arrow", () => {
    const { send } = mount();
    expect(send.getAttribute("aria-label")).toBe("Send");
    expect(send.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("asks a real question in the placeholder instead of a shrug", () => {
    mount();
    const box = host?.querySelector("textarea") as HTMLTextAreaElement;
    expect(box.placeholder).toBe("Ask about this tab...");
    expect(box.getAttribute("aria-label")).toBe("Ask Zavi about this page");
  });
});
