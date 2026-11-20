
import { getAppSetting } from "@/services/settings";
import { logEvent } from "@/services/logging/logEvent";
import { ProductBuilderUnavailable } from "./product-builder-unavailable";

export {
  PRODUCT_BUILDER_UNAVAILABLE_CODE,
  PRODUCT_BUILDER_UNAVAILABLE_MESSAGE,
  ProductBuilderUnavailable,
  isProductBuilderUnavailable,
  productBuilderUnavailableBody,
  respondProductBuilderUnavailable,
} from "./product-builder-unavailable";

export type ProductBuilderGate = "enabled" | "disabled" | "unavailable";

export async function readProductBuilderGate(): Promise<ProductBuilderGate> {
  let v: unknown;
  try {
    v = await getAppSetting("product_builder_enabled", null, { strict: true });
  } catch (e) {
    const message = String((e as Error)?.message ?? e).slice(0, 300);
    console.error(`[product-builder-flag] product_builder_enabled read failed, building paused: ${message}`);
    void logEvent({
      level: "error",
      source: "product-builder-flag",
      code: "product_builder_flag_read_failed",
      message: `product_builder_enabled could not be read; building is paused (fail closed): ${message}`,
    }).catch(() => undefined);
    return "unavailable";
  }
  if (v !== undefined) return v === true ? "enabled" : "disabled";
  return process.env.PRODUCT_BUILDER_ENABLED !== "0" ? "enabled" : "disabled";
}

export async function isProductBuilderEnabled(): Promise<boolean> {
  const gate = await readProductBuilderGate();
  if (gate === "unavailable") throw new ProductBuilderUnavailable();
  return gate === "enabled";
}
