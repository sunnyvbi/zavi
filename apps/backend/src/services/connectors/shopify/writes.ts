export const SHOPIFY_PRODUCTS_TOOL = "SHOPIFY_GRAPH_QL_PRODUCTS";
export const SHOPIFY_WRITE_OPERATIONS_TOOL = "SHOPIFY_GRAPH_QL_WRITE_OPERATIONS";
export const SHOPIFY_PRODUCT_UPDATE_OPERATION = "update_product";
export const SHOPIFY_DISCOUNT_CREATE_OPERATION = "discountCodeBasicCreate";

export const SHOPIFY_WRITE_NOT_ALLOWED_MESSAGE =
  `Zavi can change a Shopify store in two ways only: ${SHOPIFY_PRODUCTS_TOOL} with operation ${SHOPIFY_PRODUCT_UPDATE_OPERATION} ` +
  `(variables.input.id is the product gid), and ${SHOPIFY_WRITE_OPERATIONS_TOOL} with operation ${SHOPIFY_DISCOUNT_CREATE_OPERATION} ` +
  "(variables.basicCodeDiscount with title and code). Both need the founder's approval. No custom GraphQL document.";

export const SHOPIFY_PRODUCTS_TOOL_NOTE =
  ` Operation ${SHOPIFY_PRODUCT_UPDATE_OPERATION} changes the store and needs the founder's approval before it runs; ` +
  "pass variables.input with the product gid and only the fields to change. No other mutation is available.";
export const SHOPIFY_WRITE_OPERATIONS_TOOL_NOTE =
  ` Only operation ${SHOPIFY_DISCOUNT_CREATE_OPERATION} is available: variables.basicCodeDiscount with title, code, ` +
  "startsAt, customerSelection, customerGets and optional endsAt, usageLimit, appliesOncePerCustomer.";

export type ShopifyWriteCheck = { ok: true; action: string } | { ok: false; message: string };

const PRODUCT_GID_RE = /^gid:\/\/shopify\/Product\/\d{1,20}$/;

function record(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

export function isShopifyGraphqlTool(toolSlug: string): boolean {
  return toolSlug.startsWith("SHOPIFY_GRAPH_QL_");
}

export function shopifyToolDescriptionNote(toolSlug: string): string {
  if (toolSlug === SHOPIFY_PRODUCTS_TOOL) return SHOPIFY_PRODUCTS_TOOL_NOTE;
  if (toolSlug === SHOPIFY_WRITE_OPERATIONS_TOOL) return SHOPIFY_WRITE_OPERATIONS_TOOL_NOTE;
  return "";
}

function refuse(): ShopifyWriteCheck {
  return { ok: false, message: SHOPIFY_WRITE_NOT_ALLOWED_MESSAGE };
}

function checkProductUpdate(input: Record<string, unknown>): ShopifyWriteCheck {
  const variables = record(input.variables);
  if (!variables) return refuse();
  const keys = Object.keys(variables);
  if (keys.length !== 1 || (keys[0] !== "input" && keys[0] !== "product")) return refuse();
  const product = record(variables.input) ?? record(variables.product);
  if (!product || !nonEmptyString(product.id) || !PRODUCT_GID_RE.test(product.id)) return refuse();
  if (Object.keys(product).length < 2) return refuse();
  return { ok: true, action: "Update a product" };
}

function checkDiscountCreate(input: Record<string, unknown>): ShopifyWriteCheck {
  const variables = record(input.variables);
  if (!variables) return refuse();
  const discount = record(variables.basicCodeDiscount);
  if (!discount || !nonEmptyString(discount.title) || !nonEmptyString(discount.code)) return refuse();
  return { ok: true, action: `Create discount code ${discount.code.trim()}` };
}

export function checkShopifyWrite(toolSlug: string, args: unknown): ShopifyWriteCheck {
  const input = record(args);
  if (!input) return refuse();
  if (input.custom_document !== undefined || input.operation_name !== undefined) return refuse();
  if (toolSlug === SHOPIFY_PRODUCTS_TOOL && input.operation === SHOPIFY_PRODUCT_UPDATE_OPERATION) return checkProductUpdate(input);
  if (toolSlug === SHOPIFY_WRITE_OPERATIONS_TOOL && input.operation === SHOPIFY_DISCOUNT_CREATE_OPERATION) return checkDiscountCreate(input);
  return refuse();
}
