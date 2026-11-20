import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ShopifyAppBridgeHead } from "../ShopifyAppBridgeHead";

describe("Shopify App Bridge document head", () => {
  it("renders the public app key before Shopify's blocking CDN script", () => {
    const html = renderToStaticMarkup(<ShopifyAppBridgeHead enabled />);
    expect(html).toContain('name="shopify-api-key"');
    expect(html).toContain('content="1f33c6baa48742291e4f155a592a6a40"');
    expect(html).toContain('src="https://cdn.shopify.com/shopifycloud/app-bridge.js"');
    expect(html.indexOf("shopify-api-key")).toBeLessThan(html.indexOf("app-bridge.js"));
    expect(html).not.toContain("async");
    expect(html).not.toContain("defer");
  });

  it("adds nothing to non-Shopify pages", () => {
    expect(renderToStaticMarkup(<ShopifyAppBridgeHead enabled={false} />)).toBe("");
  });
});
