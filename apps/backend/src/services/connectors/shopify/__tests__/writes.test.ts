import { describe, it, expect } from "vitest";
import { checkShopifyWrite, isShopifyGraphqlTool, shopifyToolDescriptionNote } from "../writes";

const product = (input: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  checkShopifyWrite("SHOPIFY_GRAPH_QL_PRODUCTS", { operation: "update_product", variables: { input }, ...extra });
const discount = (basicCodeDiscount: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  checkShopifyWrite("SHOPIFY_GRAPH_QL_WRITE_OPERATIONS", { operation: "discountCodeBasicCreate", variables: { basicCodeDiscount }, ...extra });

describe("checkShopifyWrite", () => {
  it("allows a product update that names one product and at least one field", () => {
    expect(product({ id: "gid://shopify/Product/123", title: "Blue mug" })).toEqual({ ok: true, action: "Update a product" });
    expect(checkShopifyWrite("SHOPIFY_GRAPH_QL_PRODUCTS", { operation: "update_product", variables: { product: { id: "gid://shopify/Product/1", status: "DRAFT" } } }).ok).toBe(true);
  });
  it("refuses a product update without a product gid or without a change", () => {
    expect(product({ title: "x" }).ok).toBe(false);
    expect(product({ id: "123", title: "x" }).ok).toBe(false);
    expect(product({ id: "gid://shopify/ProductVariant/1", title: "x" }).ok).toBe(false);
    expect(product({ id: "gid://shopify/Product/1" }).ok).toBe(false);
  });
  it("allows a basic discount code with a title and a code", () => {
    expect(discount({ title: "Spring sale", code: " SPRING10 ", customerGets: {} })).toEqual({ ok: true, action: "Create discount code SPRING10" });
  });
  it("refuses a discount without a title or code", () => {
    expect(discount({ title: "Spring sale" }).ok).toBe(false);
    expect(discount({ code: "SPRING10" }).ok).toBe(false);
    expect(discount({ title: "", code: "SPRING10" }).ok).toBe(false);
  });
  it("refuses every other operation, custom documents, and malformed arguments", () => {
    expect(checkShopifyWrite("SHOPIFY_GRAPH_QL_PRODUCTS", { operation: "delete_product", variables: { input: { id: "gid://shopify/Product/1" } } }).ok).toBe(false);
    expect(checkShopifyWrite("SHOPIFY_GRAPH_QL_PRODUCTS", { operation: "update_product", variables: { input: { id: "gid://shopify/Product/1", title: "x" }, media: [{ originalSource: "https://x/y.png", mediaContentType: "IMAGE" }] } }).ok).toBe(false);
    expect(checkShopifyWrite("SHOPIFY_GRAPH_QL_PRODUCTS", { operation: "update_product", variables: { input: { id: "gid://shopify/Product/1", title: "x" }, product: { id: "gid://shopify/Product/2", title: "y" } } }).ok).toBe(false);
    expect(checkShopifyWrite("SHOPIFY_GRAPH_QL_PRODUCTS", { operation: "list_products" }).ok).toBe(false);
    expect(checkShopifyWrite("SHOPIFY_GRAPH_QL_WRITE_OPERATIONS", { operation: "discountCodeDelete", variables: {} }).ok).toBe(false);
    expect(checkShopifyWrite("SHOPIFY_GRAPH_QL_WRITE_OPERATIONS", { operation: "update_product", variables: { input: { id: "gid://shopify/Product/1", title: "x" } } }).ok).toBe(false);
    expect(checkShopifyWrite("SHOPIFY_GRAPH_QL_ADMIN_EXECUTE", { operation: "update_product" }).ok).toBe(false);
    expect(product({ id: "gid://shopify/Product/1", title: "x" }, { custom_document: "mutation { productDelete }" }).ok).toBe(false);
    expect(discount({ title: "a", code: "b" }, { operation_name: "Other" }).ok).toBe(false);
    expect(checkShopifyWrite("SHOPIFY_GRAPH_QL_PRODUCTS", "update_product").ok).toBe(false);
    expect(checkShopifyWrite("SHOPIFY_GRAPH_QL_PRODUCTS", undefined).ok).toBe(false);
    const refused = checkShopifyWrite("SHOPIFY_GRAPH_QL_PRODUCTS", { operation: "update_product", variables: [] });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.message).toContain("discountCodeBasicCreate");
  });
});

describe("tool notes", () => {
  it("names the write tools and leaves other tools unannotated", () => {
    expect(isShopifyGraphqlTool("SHOPIFY_GRAPH_QL_ORDERS")).toBe(true);
    expect(isShopifyGraphqlTool("SHOPIFY_GET_PRODUCTS")).toBe(false);
    expect(shopifyToolDescriptionNote("SHOPIFY_GRAPH_QL_PRODUCTS")).toContain("update_product");
    expect(shopifyToolDescriptionNote("SHOPIFY_GRAPH_QL_WRITE_OPERATIONS")).toContain("discountCodeBasicCreate");
    expect(shopifyToolDescriptionNote("SHOPIFY_GRAPH_QL_ORDERS")).toBe("");
    expect(shopifyToolDescriptionNote("GMAIL_SEND_EMAIL")).toBe("");
  });
});
