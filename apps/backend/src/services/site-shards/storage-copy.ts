
import { SITE_FILES_BUCKET, type ShardSql } from "./contract";
import type { FileCopier } from "./export-v2";
import { textLit } from "./sql";

type Res = { status: number; headers: { get(n: string): string | null }; body: unknown };
type Fetch = (url: string, init: Record<string, unknown>) => Promise<Res>;

const NAME_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[^\u0000]{1,1000}$/;
const REF_RE = /^[a-z0-9]{8,40}$/;
const enc = (name: string) => name.split("/").map(encodeURIComponent).join("/");

export function createStorageCopier(deps: {
  sql: ShardSql;
  serviceKey: (project_ref: string) => Promise<string>;
  fetchFn?: Fetch;
}): FileCopier {
  const fetchFn: Fetch = deps.fetchFn ?? ((url, init) => fetch(url, init as RequestInit) as unknown as Promise<Res>);
  return async ({ source_project_ref, name, target_project_ref }) => {
    if (!NAME_RE.test(name)) throw new Error("storage copy: bad object name");
    if (!REF_RE.test(source_project_ref) || !REF_RE.test(target_project_ref) || source_project_ref === target_project_ref) {
      throw new Error("storage copy: bad project refs");
    }
    const [srcKey, dstKey] = await Promise.all([deps.serviceKey(source_project_ref), deps.serviceKey(target_project_ref)]);
    const path = `/storage/v1/object/${SITE_FILES_BUCKET}/${enc(name)}`;
    const got = await fetchFn(`https://${source_project_ref}.supabase.co${path}`, {
      method: "GET",
      headers: { apikey: srcKey, Authorization: `Bearer ${srcKey}` },
    });
    if (got.status !== 200) throw new Error(`storage copy: download failed (${got.status})`);
    const put = await fetchFn(`https://${target_project_ref}.supabase.co${path}`, {
      method: "POST",
      headers: {
        apikey: dstKey,
        Authorization: `Bearer ${dstKey}`,
        "x-upsert": "true",
        "Content-Type": got.headers.get("content-type") ?? "application/octet-stream",
      },
      body: got.body,
      duplex: "half",
    });
    if (put.status < 200 || put.status >= 300) throw new Error(`storage copy: upload failed (${put.status})`);
    const own = (await deps.sql.query(
      source_project_ref,
      `select owner_id, owner::text as owner from storage.objects where bucket_id = ${textLit(SITE_FILES_BUCKET)} and name = ${textLit(name)}`,
    )) as Array<{ owner_id?: string | null; owner?: string | null }>;
    const o = own[0];
    if (o && (o.owner_id || o.owner)) {
      await deps.sql.query(
        target_project_ref,
        `update storage.objects set owner_id = ${o.owner_id ? textLit(o.owner_id) : "null"},
                owner = ${o.owner ? `${textLit(o.owner)}::uuid` : "null"}
          where bucket_id = ${textLit(SITE_FILES_BUCKET)} and name = ${textLit(name)}`,
      );
    }
  };
}
