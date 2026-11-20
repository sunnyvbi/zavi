
import { HarnessFailure } from "@/services/eval/shadow-harness";

export type BenchTenant = {
  company: string;
  id: string | null;
  id_prefix: string;
  shape: string;
  fleet?: boolean;
};

export const BENCH_TENANTS: ReadonlyArray<Readonly<BenchTenant>> = Object.freeze([
  Object.freeze({
    company: "upcar-ai",
    id: "73db45ff-457e-4541-bc8f-bdb625390204",
    id_prefix: "73db45ff",
    shape: "marketplace",
  }),
  Object.freeze({
    company: "apna-tutor",
    id: "f47c4bdc-c90d-424f-ab68-bf8b045ac8c0",
    id_prefix: "f47c4bdc",
    shape: "tutoring",
  }),
  Object.freeze({
    company: "couple-app",
    id: "b2cbf8d4-725c-499d-b346-d23b537a19a0",
    id_prefix: "b2cbf8d4",
    shape: "consumer app",
  }),
  Object.freeze({
    company: "mohit-b85fcff2",
    id: "b92dcbf1-bac9-457a-af81-0bbe5984339b",
    id_prefix: "b92dcbf1",
    shape: "website build (test tenant)",
    fleet: false,
  }),
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function assertBenchTenant(tenantId: unknown): Readonly<BenchTenant> {
  if (typeof tenantId !== "string" || !UUID.test(tenantId)) {
    throw new HarnessFailure(
      `bench tenant refused: ${JSON.stringify(tenantId)} is not a full tenant uuid`,
    );
  }
  const t = BENCH_TENANTS.find((b) => b.id !== null && b.id === tenantId);
  if (!t) {
    throw new HarnessFailure(
      `bench tenant refused: ${tenantId} is not on the model-bench allowlist ` +
        `(${BENCH_TENANTS.map((b) => b.company).join(", ")}). Fail-closed.`,
    );
  }
  return t;
}

export function pinnedBenchTenants(): ReadonlyArray<Readonly<BenchTenant>> {
  return BENCH_TENANTS.filter((b) => b.id !== null);
}

export function fleetBenchTenants(): ReadonlyArray<Readonly<BenchTenant>> {
  return pinnedBenchTenants().filter((b) => b.fleet !== false);
}
