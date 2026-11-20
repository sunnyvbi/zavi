import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const betaCreate = vi.fn(async () => ({ sandboxId: "sbx_test" }));

vi.mock("e2b", () => ({
  Sandbox: { betaCreate },
}));

describe("createSandbox — E2B_DEFAULT_TEMPLATE invariant", () => {
  const prevTpl = process.env.E2B_DEFAULT_TEMPLATE;
  const prevKey = process.env.E2B_API_KEY;

  beforeEach(() => {
    betaCreate.mockClear();
    process.env.E2B_API_KEY = "test-key";
  });
  afterEach(() => {
    if (prevTpl === undefined) delete process.env.E2B_DEFAULT_TEMPLATE;
    else process.env.E2B_DEFAULT_TEMPLATE = prevTpl;
    if (prevKey === undefined) delete process.env.E2B_API_KEY;
    else process.env.E2B_API_KEY = prevKey;
  });

  it("UNSET → defaults to 'praxis-qa' (positional template arg)", async () => {
    delete process.env.E2B_DEFAULT_TEMPLATE;
    const { createSandbox } = await import("../e2b-client");
    await createSandbox({ tenant_id: "t1", repo_full_name: "o/r" });
    expect(betaCreate).toHaveBeenCalledTimes(1);
    const args = betaCreate.mock.calls[0] as unknown[];
    expect(args[0]).toBe("praxis-qa");
    expect(typeof args[1]).toBe("object");
  });

  it("SET → overrides the default with the env value (positional)", async () => {
    process.env.E2B_DEFAULT_TEMPLATE = "some-other-template";
    const { createSandbox } = await import("../e2b-client");
    await createSandbox({ tenant_id: "t1", repo_full_name: "o/r" });
    expect(betaCreate).toHaveBeenCalledTimes(1);
    const args = betaCreate.mock.calls[0] as unknown[];
    expect(args[0]).toBe("some-other-template");
    expect(typeof args[1]).toBe("object");
  });

  it("blank/whitespace E2B_DEFAULT_TEMPLATE falls back to 'praxis-qa'", async () => {
    process.env.E2B_DEFAULT_TEMPLATE = "   ";
    const { createSandbox } = await import("../e2b-client");
    await createSandbox({ tenant_id: "t1", repo_full_name: "o/r" });
    const args = betaCreate.mock.calls[0] as unknown[];
    expect(args[0]).toBe("praxis-qa");
  });

  it("explicit args.template overrides E2B_DEFAULT_TEMPLATE", async () => {
    process.env.E2B_DEFAULT_TEMPLATE = "env-template";
    const { createSandbox } = await import("../e2b-client");
    await createSandbox({
      tenant_id: "t1",
      repo_full_name: "o/r",
      template: "praxis-large",
    });
    const args = betaCreate.mock.calls[0] as unknown[];
    expect(args[0]).toBe("praxis-large");
  });

  it("blank args.template falls through to env then default", async () => {
    delete process.env.E2B_DEFAULT_TEMPLATE;
    const { createSandbox } = await import("../e2b-client");
    await createSandbox({
      tenant_id: "t1",
      repo_full_name: "o/r",
      template: "  ",
    });
    const args = betaCreate.mock.calls[0] as unknown[];
    expect(args[0]).toBe("praxis-qa");
  });
});
