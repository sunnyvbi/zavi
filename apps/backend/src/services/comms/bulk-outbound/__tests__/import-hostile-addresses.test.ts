import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => ({ calls: [] as Array<{ name: string; args: Record<string, unknown> }> }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => ({
    from: () => {
      const q = { select: () => q, eq: () => q, order: () => q, range: async () => ({ data: [], error: null }) };
      return q;
    },
  }),
  tenantRpc: async (_t: string, name: string, args: Record<string, unknown>) => {
    rpc.calls.push({ name, args });
    const emails = (args.p_emails as string[]) ?? [];
    return { data: { ok: true, list_id: "L1", version_id: "V1", contact_count: emails.length, already_blocked: 0 }, error: null };
  },
}));

import { addressIn, cleanAddresses, csvColumnValues } from "../contacts-csv";
import { importListVersion } from "../lists";

const HOSTILE = [
  "<script>alert(1)</script>@yopmail.com",
  "<img src=x onerror=alert(1)>@yopmail.com",
  "a<b@yopmail.com",
  "a>b@yopmail.com",
  "a;b@yopmail.com",
  "a,b@yopmail.com",
  "\"quoted\"@yopmail.com",
  "x@yopmail.com<script>",
];

beforeEach(() => {
  rpc.calls.length = 0;
});

describe("a value that is not a plain address is never stored as a contact", () => {
  it.each(HOSTILE)("addressIn refuses %s", (v) => {
    expect(addressIn(v)).toBeNull();
  });

  it("cleanAddresses counts every hostile value as invalid and keeps only the real addresses", () => {
    const out = cleanAddresses([...HOSTILE, "Real@Example.com", "Ana <ana@example.com>", "mailto:bo@example.com"], 100);
    expect(out).toEqual({ emails: ["real@example.com", "ana@example.com", "bo@example.com"], invalid: HOSTILE.length, duplicates: 0, over_limit: 0 });
  });

  it("the QA CSV: the script value is dropped on the way in from a file, the real row is kept", () => {
    const csv = Buffer.from('email\n"<script>alert(1)</script>@yopmail.com"\nok@example.com\n');
    const values = csvColumnValues(csv, "email");
    expect(values).toEqual(["<script>alert(1)</script>@yopmail.com", "ok@example.com"]);
    expect(cleanAddresses(values, 100)).toMatchObject({ emails: ["ok@example.com"], invalid: 1 });
  });

  it.each(["csv", "database"] as const)("a %s import sends only clean addresses to the database", async (sourceKind) => {
    const out = await importListVersion({
      tenantId: "t1",
      userId: "u1",
      name: "Members",
      sourceKind,
      values: [...HOSTILE, "ok@example.com"],
      cap: 100,
    });
    expect(out).toMatchObject({ added: 1, invalid: HOSTILE.length });
    expect(rpc.calls).toHaveLength(1);
    expect(rpc.calls[0].name).toBe("email_list_import_version");
    expect(rpc.calls[0].args.p_emails).toEqual(["ok@example.com"]);
    expect(rpc.calls[0].args.p_source_kind).toBe(sourceKind);
  });

  it("a column of only hostile values imports nothing and never calls the database", async () => {
    await expect(
      importListVersion({ tenantId: "t1", userId: "u1", name: "Members", sourceKind: "database", values: HOSTILE, cap: 100 }),
    ).rejects.toMatchObject({ code: "no_addresses" });
    expect(rpc.calls).toHaveLength(0);
  });
});
