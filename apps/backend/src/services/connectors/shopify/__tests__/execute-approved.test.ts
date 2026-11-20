import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ proxy: vi.fn() }));
vi.mock("@/services/connectors/composio/api", () => ({ composioProxy: m.proxy }));

import { executeApprovedShopifyProductUpdate } from "../execute-approved";

const account = {
  tenant_id: "TENANT_A",
  toolkit: "shopify",
  connected_account_id: "ca_shopify",
  auth_config_id: "ac_shopify",
} as never;

const approved = {
  operation: "update_product",
  variables: {
    input: {
      id: "gid://shopify/Product/9",
      title: "Updated title",
      tags: ["existing", "zavi-e2e"],
    },
  },
};

function success(product: Record<string, unknown> | null = {
  id: "gid://shopify/Product/9",
  title: "Updated title",
  tags: ["existing", "zavi-e2e"],
}) {
  return {
    ok: true,
    status: 200,
    json: { data: { productUpdate: { product, userErrors: [] } } },
  };
}

beforeEach(() => { m.proxy.mockReset(); });

describe("executeApprovedShopifyProductUpdate", () => {
  it("uses a server-owned current Shopify mutation and the exact approved product fields", async () => {
    m.proxy.mockResolvedValue(success());

    const result = await executeApprovedShopifyProductUpdate({ account, arguments: approved });

    expect(result.ok).toBe(true);
    expect(m.proxy).toHaveBeenCalledTimes(1);
    const call = m.proxy.mock.calls[0][0];
    expect(call.account).toBe(account);
    expect(call.method).toBe("POST");
    expect(call.endpoint).toBe("/admin/api/2026-10/graphql.json");
    expect(call.headers).toEqual({ "Content-Type": "application/json" });
    expect(call.body.variables).toEqual({ product: approved.variables.input });
    expect(call.body.query).toContain("productUpdate(product: $product)");
    expect(call.body.query).toContain("userErrors");
    expect(call.body.query).toContain("field");
    expect(call.body.query).toContain("message");
    expect(call.body.query).not.toMatch(/userErrors\s*\{[^}]*\bcode\b/s);
  });

  it("returns Shopify user errors as a definite refusal", async () => {
    m.proxy.mockResolvedValue({
      ok: true,
      status: 200,
      json: {
        data: {
          productUpdate: {
            product: null,
            userErrors: [{ field: ["product", "title"], message: "Title is too long" }],
          },
        },
      },
    });

    expect(await executeApprovedShopifyProductUpdate({ account, arguments: approved })).toMatchObject({
      ok: false,
      error: "Title is too long",
      outcome_unknown: false,
    });
  });

  it.each([
    [0, { error: "composio_transport_error" }],
    [502, { error: { message: "Bad gateway", status: 502 } }],
  ])("treats proxy status %s as outcome unknown", async (status, json) => {
    m.proxy.mockResolvedValue({ ok: false, status, json });
    expect(await executeApprovedShopifyProductUpdate({ account, arguments: approved })).toMatchObject({
      ok: false,
      outcome_unknown: true,
    });
  });

  it("treats a definite proxy refusal as failed, not unknown", async () => {
    m.proxy.mockResolvedValue({ ok: false, status: 401, json: { error: { message: "Invalid token", status: 401 } } });
    expect(await executeApprovedShopifyProductUpdate({ account, arguments: approved })).toMatchObject({
      ok: false,
      error: "Invalid token",
      outcome_unknown: false,
    });
  });

  it("fails closed before the proxy when the frozen arguments are not the allowed product update", async () => {
    const disallowed = { operation: "delete_product", variables: { input: approved.variables.input } };
    expect(await executeApprovedShopifyProductUpdate({ account, arguments: disallowed })).toMatchObject({
      ok: false,
      status: 400,
      outcome_unknown: false,
    });
    expect(m.proxy).not.toHaveBeenCalled();
  });

  it("does not claim success for GraphQL errors, malformed responses, or a different returned product", async () => {
    for (const response of [
      { ok: true, status: 200, json: { data: { productUpdate: null }, errors: [{ message: "Resolver failed" }] } },
      { ok: true, status: 200, json: { data: {} } },
      success({ id: "gid://shopify/Product/10" }),
    ]) {
      m.proxy.mockResolvedValueOnce(response);
      expect(await executeApprovedShopifyProductUpdate({ account, arguments: approved })).toMatchObject({
        ok: false,
        outcome_unknown: true,
      });
    }
  });

  it("treats GraphQL errors with no data (rejected before execution) as a definite refusal", async () => {
    m.proxy.mockResolvedValue({
      ok: true,
      status: 200,
      json: { errors: [{ message: "Variable $product of type ProductUpdateInput! was provided invalid value for published" }] },
    });
    expect(await executeApprovedShopifyProductUpdate({ account, arguments: approved })).toMatchObject({
      ok: false,
      error: expect.stringContaining("invalid value for published"),
      outcome_unknown: false,
    });
  });
});
