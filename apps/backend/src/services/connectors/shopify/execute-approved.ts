import { z } from "zod";
import { composioProxy, type OwnedComposioAccount } from "@/services/connectors/composio/api";
import { shopifyAdminGraphqlPath } from "./graphql";
import {
  checkShopifyWrite,
  SHOPIFY_PRODUCTS_TOOL,
  SHOPIFY_PRODUCT_UPDATE_OPERATION,
} from "./writes";

const WRITE_TIMEOUT_MS = 20_000;

const PRODUCT_UPDATE_MUTATION = `
  mutation ZaviProductUpdate($product: ProductUpdateInput!) {
    productUpdate(product: $product) {
      product {
        id
        title
        tags
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const graphqlEnvelopeSchema = z.object({
  data: z.object({
    productUpdate: z.object({
      product: z.object({
        id: z.string(),
        title: z.string().optional(),
        tags: z.array(z.string()).optional(),
      }).passthrough().nullable(),
      userErrors: z.array(z.object({
        field: z.array(z.string()).nullable().optional(),
        message: z.string(),
      })),
    }).nullable(),
  }).optional(),
  errors: z.array(z.object({ message: z.string() }).passthrough()).optional(),
}).passthrough();

export type ApprovedShopifyWriteResult = {
  ok: boolean;
  status: number;
  data: unknown;
  error: unknown;
  outcome_unknown: boolean;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function productInput(args: Record<string, unknown>): Record<string, unknown> | null {
  const variables = record(args.variables);
  return variables ? record(variables.input) ?? record(variables.product) : null;
}

function proxyErrorMessage(json: Record<string, unknown>, status: number): string {
  const error = json.error;
  if (typeof error === "string" && error.trim()) return error.trim();
  const wrapped = record(error);
  if (typeof wrapped?.message === "string" && wrapped.message.trim()) return wrapped.message.trim();
  return `HTTP ${status}`;
}

export async function executeApprovedShopifyProductUpdate(args: {
  account: OwnedComposioAccount;
  arguments: Record<string, unknown>;
}): Promise<ApprovedShopifyWriteResult> {
  const allowed = checkShopifyWrite(SHOPIFY_PRODUCTS_TOOL, args.arguments);
  const product = productInput(args.arguments);
  if (!allowed.ok || args.arguments.operation !== SHOPIFY_PRODUCT_UPDATE_OPERATION || !product) {
    return {
      ok: false,
      status: 400,
      data: null,
      error: `shopify_write_not_allowed: ${allowed.ok ? "Only an approved product update can run here." : allowed.message}`,
      outcome_unknown: false,
    };
  }

  const response = await composioProxy({
    account: args.account,
    method: "POST",
    endpoint: shopifyAdminGraphqlPath(),
    headers: { "Content-Type": "application/json" },
    body: {
      query: PRODUCT_UPDATE_MUTATION,
      variables: { product },
    },
  }, AbortSignal.timeout(WRITE_TIMEOUT_MS));

  if (!response.ok) {
    const outcomeUnknown = response.status === 0 || response.status >= 500;
    return {
      ok: false,
      status: response.status,
      data: response.json,
      error: outcomeUnknown ? "composio_outcome_unknown" : proxyErrorMessage(response.json, response.status),
      outcome_unknown: outcomeUnknown,
    };
  }

  const envelope = graphqlEnvelopeSchema.safeParse(response.json);
  if (envelope.success && envelope.data.errors?.length && !("data" in response.json)) {
    return {
      ok: false,
      status: response.status,
      data: response.json,
      error: envelope.data.errors.map((item) => item.message).join("; "),
      outcome_unknown: false,
    };
  }
  if (!envelope.success || envelope.data.errors?.length || !envelope.data.data?.productUpdate) {
    return {
      ok: false,
      status: response.status,
      data: response.json,
      error: "shopify_outcome_unknown",
      outcome_unknown: true,
    };
  }

  const result = envelope.data.data.productUpdate;
  if (result.userErrors.length) {
    return {
      ok: false,
      status: response.status,
      data: response.json,
      error: result.userErrors.map((item) => item.message).join("; "),
      outcome_unknown: false,
    };
  }

  if (result.product?.id !== product.id) {
    return {
      ok: false,
      status: response.status,
      data: response.json,
      error: "shopify_outcome_unknown",
      outcome_unknown: true,
    };
  }

  return {
    ok: true,
    status: response.status,
    data: response.json,
    error: null,
    outcome_unknown: false,
  };
}
