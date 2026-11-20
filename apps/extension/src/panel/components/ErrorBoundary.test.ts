
import { act, createElement, type JSX } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary";
import { CrashScreen, describe as describeError } from "./CrashScreen";

function Boom(): JSX.Element {
  throw new Error("kaboom from a child");
}

function renderClient(node: Parameters<typeof createRoot>[0] extends never ? never : JSX.Element): string {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => {
    root.render(node);
  });
  const html = host.textContent ?? "";
  act(() => root.unmount());
  host.remove();
  return html;
}

describe("ErrorBoundary", () => {
  it("replaces a throwing child with the crash screen instead of nothing", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const html = renderClient(createElement(ErrorBoundary, null, createElement(Boom)));
    err.mockRestore();

    expect(html).toContain("Zavi hit an error and stopped");
    expect(html).toContain("kaboom from a child");
  });

  it("renders its children untouched when nothing throws", () => {
    const html = renderClient(
      createElement(ErrorBoundary, null, createElement("p", null, "the real panel")),
    );
    expect(html).toContain("the real panel");
    expect(html).not.toContain("Zavi hit an error");
  });
});

describe("CrashScreen", () => {
  it("shows the error text, not just an apology", () => {
    const html = renderToStaticMarkup(
      createElement(CrashScreen, {
        error: new Error("supabaseUrl is required"),
        onReload: () => {},
      }),
    );
    expect(html).toContain("supabaseUrl is required");
    expect(html).toContain("not something you did");
  });

  it("survives a non-Error throw — a string, an object, null", () => {
    for (const thrown of ["plain string", { code: 42 }, null]) {
      const html = renderToStaticMarkup(
        createElement(CrashScreen, { error: thrown, onReload: () => {} }),
      );
      expect(html).toContain("Zavi hit an error and stopped");
    }
  });
});

describe("describe()", () => {
  it("keeps the stack for an Error, because a minified panel needs it", () => {
    const e = new Error("boom");
    expect(describeError(e)).toContain("boom");
    expect(describeError(e)).toContain("at ");
  });

  it("never throws on a value that cannot be stringified", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => describeError(circular)).not.toThrow();
  });
});
