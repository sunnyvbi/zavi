
import { z } from "zod";
import { figmaGet } from "./_client";
import { ExpectedToolError, type ToolSpec } from "@/services/tools/types";

const DEFAULT_DEPTH = 3;
const MAX_DEPTH = 6;
const MAX_NODES = 1200;

const inputSchema = z.object({
  file_key: z
    .string()
    .min(1)
    .max(128)
    .describe(
      "The Figma file key from the file URL — figma.com/file/<file_key>/... or figma.com/design/<file_key>/...",
    ),
  depth: z
    .number()
    .int()
    .min(1)
    .max(MAX_DEPTH)
    .optional()
    .describe(
      `How many levels of the document tree to traverse (1 = pages only, 2 = pages + top-level frames, ...). ` +
        `Default ${DEFAULT_DEPTH}, hard max ${MAX_DEPTH}.`,
    ),
});

type RawNode = {
  id?: unknown;
  name?: unknown;
  type?: unknown;
  children?: unknown;
};

type TrimmedNode = {
  id?: string;
  name?: string;
  type?: string;
  children?: TrimmedNode[];
};

export const figmaGetFileTool: ToolSpec = {
  name: "figma_get_file",
  effect: "read",
  description:
    `Get the TRIMMED document tree of a Figma file — node id, name, type, and hierarchy only (no colors, ` +
    `fills, text content, or layout/position data). A raw Figma file is enormous, so traversal depth is ` +
    `capped at ${MAX_DEPTH} levels (default ${DEFAULT_DEPTH}) and the trimmed result is hard-capped at ` +
    `${MAX_NODES} nodes; a deeper or wider tree is truncated with a flag rather than returned in full. Use ` +
    `this to see what pages, frames, groups, and components a design file contains. Throws ` +
    `figma_not_connected if the operator has not connected Figma yet.`,
  input_schema: inputSchema,
  async execute(ctx, input) {
    const { file_key, depth } = inputSchema.parse(input);
    const boundedDepth = Math.min(depth ?? DEFAULT_DEPTH, MAX_DEPTH);

    const data = (await figmaGet(
      ctx.tenant_id,
      `/v1/files/${encodeURIComponent(file_key)}?depth=${boundedDepth}`,
    )) as { name?: unknown; lastModified?: unknown; document?: unknown };

    if (!data.document || typeof data.document !== "object") {
      throw new ExpectedToolError(
        "figma_get_file_failed",
        "Figma returned a file with no document tree. Check the file key.",
        { next_step: "revise_input" },
      );
    }

    let nodeCount = 0;
    let truncated = false;

    function trim(node: RawNode): TrimmedNode | null {
      if (truncated) return null;
      nodeCount += 1;
      if (nodeCount > MAX_NODES) {
        truncated = true;
        return null;
      }
      const out: TrimmedNode = {
        id: typeof node.id === "string" ? node.id : undefined,
        name: typeof node.name === "string" ? node.name : undefined,
        type: typeof node.type === "string" ? node.type : undefined,
      };
      if (Array.isArray(node.children)) {
        const kids: TrimmedNode[] = [];
        for (const child of node.children as RawNode[]) {
          const trimmedChild = trim(child as RawNode);
          if (trimmedChild) kids.push(trimmedChild);
          if (truncated) break;
        }
        out.children = kids;
      }
      return out;
    }

    const tree = trim(data.document as RawNode);

    return {
      file_key,
      name: typeof data.name === "string" ? data.name : null,
      last_modified: typeof data.lastModified === "string" ? data.lastModified : null,
      depth_requested: boundedDepth,
      node_count: nodeCount,
      truncated,
      document: tree,
      ...(truncated
        ? {
            note: `Truncated at ${MAX_NODES} nodes. Lower depth, or ask about a specific page/frame for a fuller read.`,
          }
        : {}),
    };
  },
};
