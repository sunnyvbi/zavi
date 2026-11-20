import { SHOPIFY_APP_CLIENT_ID } from "@/lib/shopify-app-home/config";

export function ShopifyAppBridgeHead({ enabled }: { enabled: boolean }) {
  if (!enabled) return null;
  return (
    <>
      <meta name="shopify-api-key" content={SHOPIFY_APP_CLIENT_ID} />
      <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js" />
    </>
  );
}
