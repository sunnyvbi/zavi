
import type { Response } from "express";

export const PRODUCT_BUILDER_UNAVAILABLE_CODE = "product_builder_unavailable";
export const PRODUCT_BUILDER_UNAVAILABLE_MESSAGE =
  "Building is paused right now. Nothing was started or charged. Please try again in a minute.";

export class ProductBuilderUnavailable extends Error {
  readonly code = PRODUCT_BUILDER_UNAVAILABLE_CODE;
  readonly status = 503;
  readonly retryable = true;
  constructor() {
    super(PRODUCT_BUILDER_UNAVAILABLE_MESSAGE);
    this.name = "ProductBuilderUnavailable";
  }
}

export function isProductBuilderUnavailable(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as { code?: unknown }).code === PRODUCT_BUILDER_UNAVAILABLE_CODE;
}

export function productBuilderUnavailableBody(): {
  error: { code: string; message: string; retryable: true };
} {
  return {
    error: { code: PRODUCT_BUILDER_UNAVAILABLE_CODE, message: PRODUCT_BUILDER_UNAVAILABLE_MESSAGE, retryable: true },
  };
}

export function respondProductBuilderUnavailable(res: Response): void {
  if (res.locals) res.locals.idempotencyRelease = true;
  res.status(503).json(productBuilderUnavailableBody());
}
