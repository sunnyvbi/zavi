// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { SetupConnectPanel } from "./SetupConnectPanel";

vi.mock("@/lib/supabase", () => ({ createBrowserSupabase: () => ({}) }));
vi.mock("@/lib/active-tenant-client", () => ({ getActiveTenantId: async () => null }));
vi.mock("../WorkspaceShell", () => ({ useWorkspace: () => ({ role: "owner" }) }));

afterEach(cleanup);

type Shape = { tag: string; attrs: string[]; children: Array<Shape | string> };
function merged(el: Element | null): Element | null {
  const copy = el?.cloneNode(true) as Element | undefined;
  copy?.normalize();
  return copy ?? null;
}
function shape(el: Element | null): Shape | null {
  if (!el) return null;
  return {
    tag: el.tagName,
    attrs: Array.from(el.attributes, (a) => `${a.name}=${a.value}`).sort(),
    children: Array.from(el.childNodes, (n) => (n instanceof Element ? shape(n)! : n.textContent ?? "")),
  };
}

it("renders the same structure on the server and once mounted, then scrolls to and focuses the panel", () => {
  Element.prototype.scrollIntoView = vi.fn();
  const panel = <SetupConnectPanel slug="stripe" teamsConfigured={false} onClose={vi.fn()} onConnected={vi.fn()} />;
  const server = document.createElement("div");
  server.innerHTML = renderToStaticMarkup(panel);
  expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();

  const { container } = render(panel);
  expect(shape(merged(container.firstElementChild))).toEqual(shape(merged(server.firstElementChild)));
  expect(document.activeElement).toBe(container.firstElementChild);
  expect(Element.prototype.scrollIntoView).toHaveBeenCalledOnce();
});
