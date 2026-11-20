
import type {
  BackendProtocolV2,
  EditResult,
  GlobResult,
  GrepResult,
  LsResult,
  ReadRawResult,
  ReadResult,
  WriteResult,
} from "deepagents";
import { asTenantId, tenantClient, type TenantId } from "@/services/tenant-client";
import { searchMemory } from "@/services/memory";

const READ_ONLY_MSG =
  "/memory/ is read-only. Memory is written through the distillers and the " +
  "memory_note_upsert_anchor RPC so provenance and trust tier are preserved. " +
  "If you learned something durable, say so in your reply — do not write a file.";

type AnchorRow = { slug: string; title: string | null; body_markdown: string | null; updated_at: string | null };

function pathToSlug(filePath: string): string {
  const base = filePath.replace(/^\/+/, "").trim();
  return base.replace(/\.md$/i, "");
}

function slugToPath(slug: string): string {
  return `/${slug}.md`;
}

export type ZaviMemoryBackendOptions = {
  tenantId: string;
  runId?: string | null;
  agentSlug?: string | null;
  deps?: {
    listAnchors?: (tenantId: string) => Promise<AnchorRow[]>;
    search?: typeof searchMemory;
  };
};

export class ZaviMemoryBackend implements BackendProtocolV2 {
  readonly id = "zavi-memory";
  private readonly tenantId: string;
  private readonly tid: TenantId;
  private readonly runId: string | null;
  private readonly agentSlug: string | null;
  private readonly deps: NonNullable<ZaviMemoryBackendOptions["deps"]>;
  private cache: AnchorRow[] | null = null;

  constructor(opts: ZaviMemoryBackendOptions) {
    if (!opts.tenantId) throw new Error("ZaviMemoryBackend: tenantId is required");
    this.tenantId = opts.tenantId;
    this.tid = asTenantId(opts.tenantId);
    this.runId = opts.runId ?? null;
    this.agentSlug = opts.agentSlug ?? null;
    this.deps = opts.deps ?? {};
  }

  private async anchors(): Promise<AnchorRow[]> {
    if (this.cache) return this.cache;
    if (this.deps.listAnchors) {
      this.cache = await this.deps.listAnchors(this.tenantId);
      return this.cache;
    }
    const { data, error } = await tenantClient(this.tid)
      .from("memory_note")
      .select("slug, title, body_markdown, updated_at")
      .eq("note_type", "anchor")
      .is("superseded_by", null)
      .not("slug", "is", null);
    if (error) throw new Error(`memory anchor read failed: ${error.message}`);
    this.cache = (data ?? []) as AnchorRow[];
    return this.cache;
  }

  async ls(path: string): Promise<LsResult> {
    try {
      const rows = await this.anchors();
      void path;
      return {
        files: rows.map((r) => ({
          path: slugToPath(r.slug),
          is_dir: false,
          size: (r.body_markdown ?? "").length,
          modified_at: r.updated_at ?? undefined,
        })) as LsResult["files"],
      };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }

  async read(filePath: string, offset = 0, limit = 500): Promise<ReadResult> {
    try {
      const slug = pathToSlug(filePath);
      const row = (await this.anchors()).find((r) => r.slug === slug);
      if (!row) {
        const avail = (await this.anchors()).map((r) => slugToPath(r.slug)).join(", ");
        return { error: `No memory anchor at ${filePath}. Available: ${avail || "(none)"}` };
      }
      const lines = (row.body_markdown ?? "").split("\n");
      return { content: lines.slice(offset, offset + limit).join("\n"), mimeType: "text/markdown" };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }

  async readRaw(filePath: string): Promise<ReadRawResult> {
    const r = await this.read(filePath, 0, Number.MAX_SAFE_INTEGER);
    if (r.error) return { error: r.error };
    const now = new Date().toISOString();
    return {
      data: {
        content: (r.content as string) ?? "",
        mimeType: "text/markdown",
        created_at: now,
        modified_at: now,
      },
    } as ReadRawResult;
  }

  async grep(
    pattern: string,
    path?: string | null,
    glob?: string | null,
    maxCount?: number | null,
  ): Promise<GrepResult> {
    void path;
    void glob;
    try {
      const k = Math.min(Math.max(maxCount ?? 8, 1), 25);
      const search = this.deps.search ?? searchMemory;
      const hits = await search(this.tenantId, pattern, k, {
        run_id: this.runId,
        agent_slug: this.agentSlug,
      });
      const matches = (hits as Array<{ slug?: string | null; note_id?: string; text?: string; body?: string }>)
        .map((h, i) => ({
          path: h.slug ? slugToPath(h.slug) : `/results/${h.note_id ?? i}.md`,
          line: 1,
          text: (h.text ?? h.body ?? "").slice(0, 2000),
        }))
        .filter((m) => m.text.length > 0);
      return { matches, truncated: matches.length >= k };
    } catch (e) {
      try {
        const needle = pattern.toLowerCase();
        const matches = (await this.anchors())
          .flatMap((r) =>
            (r.body_markdown ?? "")
              .split("\n")
              .map((text, idx) => ({ path: slugToPath(r.slug), line: idx + 1, text }))
              .filter((m) => m.text.toLowerCase().includes(needle)),
          )
          .slice(0, maxCount ?? 25);
        return { matches };
      } catch {
        return { error: (e as Error).message };
      }
    }
  }

  async glob(pattern: string, path?: string): Promise<GlobResult> {
    void path;
    try {
      const re = new RegExp(
        "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*") + "$",
      );
      const files = (await this.anchors())
        .map((r) => slugToPath(r.slug))
        .filter((p) => re.test(p))
        .map((p) => ({ path: p, is_dir: false }));
      return { files: files as GlobResult["files"] };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }

  async write(filePath: string, content: string): Promise<WriteResult> {
    void filePath;
    void content;
    return { error: READ_ONLY_MSG };
  }

  async edit(): Promise<EditResult> {
    return { error: READ_ONLY_MSG };
  }
}
