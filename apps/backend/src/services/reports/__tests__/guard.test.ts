
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExpectedToolError } from "@/services/tools/types";

type SbMock = {
  from: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  single: ReturnType<typeof vi.fn>;
};

const sbMock: SbMock = {
  from: vi.fn(),
  select: vi.fn(),
  eq: vi.fn(),
  single: vi.fn(),
};

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: sbMock.from,
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  sbMock.from.mockReturnValue({
    select: sbMock.select,
  });
  sbMock.select.mockReturnValue({ eq: sbMock.eq });
  sbMock.eq.mockReturnValue({ single: sbMock.single });
});

const importGuard = async () => await import("../guard");

describe("assertRunTenantOwnership", () => {
  it("returns the canonical tenant_id on happy path", async () => {
    sbMock.single.mockResolvedValue({
      data: { tenant_id: "tenant-A" },
      error: null,
    });
    const { assertRunTenantOwnership } = await importGuard();
    const out = await assertRunTenantOwnership({
      tenant_id: "tenant-A",
      run_id: "run-1",
    });
    expect(out).toBe("tenant-A");
    expect(sbMock.from).toHaveBeenCalledWith("agent_runs");
  });

  it("throws ExpectedToolError(run_lookup_failed) when the row is missing", async () => {
    sbMock.single.mockResolvedValue({ data: null, error: { message: "not found" } });
    const { assertRunTenantOwnership } = await importGuard();
    await expect(
      assertRunTenantOwnership({ tenant_id: "tenant-A", run_id: "missing" }),
    ).rejects.toMatchObject({
      name: "ExpectedToolError",
      code: "run_lookup_failed",
    });
  });

  it("throws ExpectedToolError(tenant_mismatch) when run belongs to a different tenant", async () => {
    sbMock.single.mockResolvedValue({
      data: { tenant_id: "tenant-B" },
      error: null,
    });
    const { assertRunTenantOwnership } = await importGuard();
    let caught: unknown;
    try {
      await assertRunTenantOwnership({
        tenant_id: "tenant-A",
        run_id: "run-of-B",
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ExpectedToolError);
    expect((caught as ExpectedToolError).code).toBe("tenant_mismatch");
  });
});
