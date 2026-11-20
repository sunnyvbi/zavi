import { z } from "zod";

const API_VERSION = () => (process.env.SHOPIFY_API_VERSION || "2026-10").trim();
const GRAPHQL_TIMEOUT_MS = 20_000;

export function shopifyAdminGraphqlPath(): string {
  return `/admin/api/${API_VERSION()}/graphql.json`;
}

export class ShopifyGraphqlError extends Error {
  constructor(readonly code: "unauthorized" | "access_denied" | "provider" | "bad_response", message: string) {
    super(message);
    this.name = "ShopifyGraphqlError";
  }
}

const envelopeSchema = z.object({
  data: z.unknown().optional(),
  errors: z.array(z.object({
    message: z.string(),
    extensions: z.record(z.string(), z.unknown()).optional(),
  })).optional(),
});

export async function shopifyGraphql<T>(args: {
  shop: string;
  accessToken: string;
  query: string;
  variables?: Record<string, unknown>;
}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`https://${args.shop}${shopifyAdminGraphqlPath()}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Shopify-Access-Token": args.accessToken,
      },
      body: JSON.stringify({ query: args.query, variables: args.variables ?? {} }),
      signal: AbortSignal.timeout(GRAPHQL_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ShopifyGraphqlError("provider", error instanceof Error ? error.message : "Shopify request failed");
  }
  if (response.status === 401) throw new ShopifyGraphqlError("unauthorized", "Shopify session expired");
  if (!response.ok) throw new ShopifyGraphqlError("provider", `Shopify returned ${response.status}`);
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new ShopifyGraphqlError("bad_response", "Shopify returned invalid JSON");
  }
  const envelope = envelopeSchema.safeParse(raw);
  if (!envelope.success) throw new ShopifyGraphqlError("bad_response", "Shopify returned an unexpected response");
  if (envelope.data.errors?.length) {
    const denied = envelope.data.errors.some((error) => error.extensions?.code === "ACCESS_DENIED");
    throw new ShopifyGraphqlError(denied ? "access_denied" : "provider", envelope.data.errors.map((error) => error.message).join("; "));
  }
  if (envelope.data.data === undefined) throw new ShopifyGraphqlError("bad_response", "Shopify returned no data");
  return envelope.data.data as T;
}
