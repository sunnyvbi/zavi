
import { textLit } from "./sql";
import { SITE_FILES_BUCKET, type ShardHandle, type ShardSql, type ShardStorage } from "./contract";

const REMOVE_BATCH = 500;
const UUID_PREFIX_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/$/;

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number }>;

export function createShardStorage(deps: {
  sql: ShardSql;
  serviceKey: (project_ref: string) => Promise<string>;
  fetchFn?: Fetch;
}): ShardStorage {
  const fetchFn: Fetch = deps.fetchFn ?? ((url, init) => fetch(url, init) as unknown as ReturnType<Fetch>);
  return {
    async list(shard: ShardHandle, prefix: string) {
      if (!UUID_PREFIX_RE.test(prefix)) throw new Error("storage list: prefix must be <site_id>/");
      const rows = (await deps.sql.query(
        shard.project_ref,
        `select name from storage.objects where bucket_id = ${textLit(SITE_FILES_BUCKET)}
            and starts_with(name, ${textLit(prefix)}) order by name`,
      )) as Array<{ name?: string }>;
      return rows.map((r) => String(r.name ?? "")).filter((n) => n.startsWith(prefix));
    },
    async remove(shard: ShardHandle, names: string[]) {
      if (!names.length) return;
      const key = await deps.serviceKey(shard.project_ref);
      for (let i = 0; i < names.length; i += REMOVE_BATCH) {
        const res = await fetchFn(`${shard.url}/storage/v1/object/${SITE_FILES_BUCKET}`, {
          method: "DELETE",
          headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({ prefixes: names.slice(i, i + REMOVE_BATCH) }),
        });
        if (res.status < 200 || res.status >= 300) throw new Error(`storage remove failed (${res.status})`);
      }
    },
  };
}
