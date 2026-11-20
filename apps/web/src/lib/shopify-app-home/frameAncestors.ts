export const SHOPIFY_APP_HOME_PATH = "/shopify/app-home";

const SHOPIFY_ADMIN_FRAME_ANCESTORS = "frame-ancestors https://admin.shopify.com https://*.myshopify.com";

export function shopifyFrameAncestors(): string {
  return SHOPIFY_ADMIN_FRAME_ANCESTORS;
}
