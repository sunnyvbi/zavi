import { describe, expect, it, vi } from "vitest";

const { rows } = vi.hoisted(() => ({ rows: { data: [] as { version: number }[], from: 0, to: 0 } }));
vi.mock("@/services/tenant-client", () => {
  const b: Record<string, unknown> = {};
  for (const op of ["from", "select", "eq", "order", "limit"]) b[op] = () => b;
  b.range = (from: number, to: number) => {
    rows.from = from;
    rows.to = to;
    return b;
  };
  b.then = (f: (v: unknown) => unknown) =>
    Promise.resolve({ data: rows.data.slice(rows.from, rows.to + 1), error: null }).then(f);
  return { tenantClient: () => b, asTenantId: (t: string) => t, globalClient: () => b, serviceClient: () => b };
});

import { submissionRounds } from "../orders-db";

describe("submissionRounds", () => {
  it("counts distinct versions, so a deleted version's gap is not a round", async () => {
    rows.data = [{ version: 2 }, { version: 2 }];
    expect(await submissionRounds("t", "o")).toBe(1);
    rows.data = [{ version: 1 }, { version: 1 }, { version: 3 }];
    expect(await submissionRounds("t", "o")).toBe(2);
    rows.data = [];
    expect(await submissionRounds("t", "o")).toBe(0);
  });

  it("reads past the first page, so many files never hide a later round", async () => {
    rows.data = [
      ...Array.from({ length: 1000 }, () => ({ version: 1 })),
      ...Array.from({ length: 500 }, () => ({ version: 2 })),
      { version: 3 },
    ];
    expect(await submissionRounds("t", "o")).toBe(3);
  });
});
