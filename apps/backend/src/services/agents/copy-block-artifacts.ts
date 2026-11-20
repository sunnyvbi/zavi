
import { asTenantId, tenantClient, tenantStorage } from "@/services/tenant-client";
import { ARTIFACT_BUCKET } from "@/services/reports/constants";

export const COPY_BLOCK_MIME = "text/plain";
const MAX_BLOCKS = 10;
const MAX_TITLE = 80;
const FALLBACK_CONTENT_TYPE = "text/csv";

export type CopyBlock = { title: string; text: string };

const FENCE = /^(`{3,}|~{3,})[ \t]*copy\b[ \t]*([^\n]*)\n([\s\S]*?)\n\1[ \t]*$/gm;

export function extractCopyBlocks(body: string): CopyBlock[] {
  const blocks: CopyBlock[] = [];
  for (const m of body.matchAll(FENCE)) {
    const text = m[3].trim();
    if (!text) continue;
    const title = m[2].trim().slice(0, MAX_TITLE) || `Copy ${blocks.length + 1}`;
    blocks.push({ title, text });
    if (blocks.length >= MAX_BLOCKS) break;
  }
  return blocks;
}

export async function saveCopyBlockArtifacts(
  ctx: { tenant_id: string; run_id: string; agent_slug: string; thread_id: string | null },
  body: string,
): Promise<number> {
  const blocks = extractCopyBlocks(body);
  if (blocks.length === 0) return 0;
  const tid = asTenantId(ctx.tenant_id);
  const storage = tenantStorage(tid).from(ARTIFACT_BUCKET);
  for (const [i, block] of blocks.entries()) {
    const filename = `copy-${i + 1}.txt`;
    const storagePath = `${tid}/${ctx.run_id}/${filename}`;
    const bytes = Buffer.from(`${block.text}\n`, "utf8");
    let { error: upErr } = await storage.upload(storagePath, bytes, { contentType: COPY_BLOCK_MIME, upsert: true });
    if (upErr && /mime type/i.test(upErr.message)) {
      ({ error: upErr } = await storage.upload(storagePath, bytes, {
        contentType: FALLBACK_CONTENT_TYPE,
        upsert: true,
      }));
    }
    if (upErr) throw new Error(`copy block upload failed: ${upErr.message}`);
    const { error } = await tenantClient(tid)
      .from("run_artifacts")
      .upsert(
        {
          tenant_id: tid,
          run_id: ctx.run_id,
          storage_path: storagePath,
          bucket: ARTIFACT_BUCKET,
          filename,
          title: block.title,
          mime: COPY_BLOCK_MIME,
          bytes: bytes.byteLength,
          agent_slug: ctx.agent_slug,
          thread_id: ctx.thread_id,
        },
        { onConflict: "tenant_id,run_id,filename" },
      );
    if (error) throw new Error(`copy block row failed: ${error.message}`);
  }
  return blocks.length;
}
