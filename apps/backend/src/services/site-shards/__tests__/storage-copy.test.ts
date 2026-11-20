import { describe, expect, it } from "vitest";
import { createStorageCopier } from "../storage-copy";

const SITE = "11111111-1111-4111-8111-111111111111";
const SRC = "shardrefabcdefgh";
const DST = "ownprojectref0001";

function setup() {
  const calls: Array<{ url: string; init: Record<string, unknown> }> = [];
  const sql: string[] = [];
  const copy = createStorageCopier({
    sql: { query: async (ref, q) => (sql.push(`${ref}: ${q}`), q.startsWith("select owner_id") ? [{ owner_id: "u1", owner: null }] : []) },
    serviceKey: async (ref) => `key-${ref}`,
    fetchFn: async (url, init) => {
      calls.push({ url, init });
      return { status: 200, headers: { get: () => "image/png" }, body: "BYTES" };
    },
  });
  return { copy, calls, sql };
}

describe("storage copier (graduation files)", () => {
  it("streams the object from the shard to the site's project (upsert) and carries its owner", async () => {
    const s = setup();
    await s.copy({ source_project_ref: SRC, name: `${SITE}/a b.png`, target_project_ref: DST });
    expect(s.calls[0].url).toBe(`https://${SRC}.supabase.co/storage/v1/object/site-files/${SITE}/a%20b.png`);
    expect(s.calls[1].url).toBe(`https://${DST}.supabase.co/storage/v1/object/site-files/${SITE}/a%20b.png`);
    expect(s.calls[1].init).toMatchObject({ method: "POST", body: "BYTES", headers: { "x-upsert": "true", "Content-Type": "image/png", apikey: `key-${DST}` } });
    expect(s.sql.some((q) => q.startsWith(`${DST}: update storage.objects set owner_id = 'u1'`))).toBe(true);
  });

  it("refuses names outside a site prefix and bad / identical project refs", async () => {
    const s = setup();
    for (const i of [
      { source_project_ref: SRC, name: "other/x.png", target_project_ref: DST },
      { source_project_ref: SRC, name: `${SITE}/x.png`, target_project_ref: SRC },
      { source_project_ref: "Bad Ref", name: `${SITE}/x.png`, target_project_ref: DST },
    ]) {
      await expect(s.copy(i)).rejects.toThrow();
    }
    expect(s.calls).toEqual([]);
  });
});
