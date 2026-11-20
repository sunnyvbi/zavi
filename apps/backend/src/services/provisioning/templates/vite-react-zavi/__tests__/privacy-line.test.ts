import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";

vi.mock("react-router-dom", async () => {
  const { createElement: h } = await import("react");
  return { Link: ({ to, ...rest }: { to: string } & Record<string, unknown>) => h("a", { ...rest, href: to }) };
});
import { renderToStaticMarkup } from "react-dom/server";
import { PRIVACY_LINE, SiteFooter } from "../files/src/components/sections/SiteFooter";

describe("starter footer privacy line", () => {
  it.each(["simple", "columns"] as const)("the %s footer tells visitors visits are counted without cookies", (variant) => {
    const html = renderToStaticMarkup(createElement(SiteFooter, { variant, name: "Northwind Yoga", links: [{ label: "Classes", href: "/classes" }] }));
    expect(html).toContain('data-zavi="privacy"');
    expect(html).toContain(PRIVACY_LINE);
  });
});
