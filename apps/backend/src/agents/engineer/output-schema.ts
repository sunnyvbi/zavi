
import { z } from "zod";
import {
  ENGINEER_PR_DISPATCH_CEILING,
  ENGINEER_PR_CAPS_PRODUCT_BUILD,
  RENDERED_MARKDOWN_MAX_CHARS,
} from "@/services/agents/engineer-caps";

function base64Chars(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

const fileChangeSchema = z
  .object({
    path: z.string().min(1).max(512),
    action: z.enum(["create", "modify", "delete"]),
    content: z
      .string()
      .max(base64Chars(ENGINEER_PR_DISPATCH_CEILING.maxPostImageBytes))
      .optional(),
    encoding: z.literal("base64").optional(),
    diff: z.string().max(ENGINEER_PR_DISPATCH_CEILING.diffByteCap).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.action === "delete") {
      if (value.content !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "delete action must not include `content`",
          path: ["content"],
        });
      }
      return;
    }
    if (typeof value.content !== "string" || value.content.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${value.action} action requires non-empty 'content' (full post-image of the file)`,
        path: ["content"],
      });
    }
  });

const baseSchema = z.object({
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "repo must be 'owner/name'"),
  base_branch: z.string().min(1).max(120),
  base_branches: z
    .array(z.string().min(1).max(120))
    .min(1)
    .max(5)
    .optional(),
  head_branch: z
    .string()
    .min(1)
    .max(120)
    .regex(
      /^(engineer|product-builder)\//,
      "head_branch must start with 'engineer/' or 'product-builder/'",
    ),
  title: z.string().min(1).max(120),
  body: z.string().max(8000).default(""),
  rendered_markdown: z.string().max(RENDERED_MARKDOWN_MAX_CHARS).optional(),
  customer_summary: z.string().max(600).optional(),
  preview_path: z.string().max(300).optional(),
  files: z
    .array(fileChangeSchema)
    .min(1)
    .max(ENGINEER_PR_DISPATCH_CEILING.maxFiles),
  test_results: z
    .object({
      passed: z.number().int().min(0),
      failed: z.number().int().min(0),
      output_tail: z.string().max(4000).default(""),
    })
    .default({ passed: 0, failed: 0, output_tail: "" }),
  risk_class: z.enum(["trivial", "low", "medium"]).default("low"),
  per_base_files: z.record(z.string(), z.array(fileChangeSchema)).optional(),
  base_conflicts: z.array(z.string()).optional(),
  push_to_main: z.boolean().optional(),
  incomplete: z.preprocess(
    (v) => (v === true || v === "true" ? true : undefined),
    z.boolean().optional(),
  ),
  remaining: z.preprocess(
    (v) =>
      Array.isArray(v)
        ? v
            .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
            .slice(0, 20)
            .map((x) => x.trim().slice(0, 400))
        : undefined,
    z.array(z.string()).optional(),
  ),
  defer_pr: z.boolean().optional(),
  refine_gate_meta: z
    .object({
      head_branch: z.string(),
      commit_sha: z.string(),
      base_branch: z.string(),
      repo: z.string(),
      title: z.string(),
      build_ok: z.boolean(),
      tests_passed: z.number().int().min(0),
      tests_failed: z.number().int().min(0),
      typecheck_ok: z.boolean().nullable(),
    })
    .optional(),
  protected_paths: z
    .array(z.object({ path: z.string().max(512), glob: z.string().max(200) }))
    .max(400)
    .optional(),
  typecheck_ok: z.boolean().nullable().optional(),
  app_verify_result: z
    .object({ path: z.string().min(1).max(512), status: z.number().int().min(100).max(599) })
    .nullable()
    .optional(),
  diagnosis: z
    .object({
      root_cause_symbol: z.string().max(200).optional(),
      reproduced: z.boolean().optional(),
      not_reproduced_reason: z.string().max(500).optional(),
    })
    .optional(),
  carried_constant_notes: z
    .array(
      z.object({
        name: z.string().min(1).max(200),
        source_path: z.string().min(1).max(512),
        why_it_holds: z.string().min(20).max(1000),
      }),
    )
    .max(20)
    .optional(),
  carried_constants: z
    .array(
      z.object({
        name: z.string().max(200),
        source_path: z.string().max(512),
      }),
    )
    .max(20)
    .optional(),
  http_route_changed: z.boolean().optional(),
  completeness_unverified: z.boolean().optional(),
  verification_notes: z.array(z.string()).optional(),
  wiring_unverified: z.boolean().optional(),
  wiring_unwired_symbols: z.array(z.string().max(200)).max(20).optional(),
});

const TOTAL_LINE_CAP = ENGINEER_PR_DISPATCH_CEILING.maxChangedLines;
const TOTAL_BYTE_CAP = ENGINEER_PR_DISPATCH_CEILING.diffByteCap;

function countDiffLines(diff: string): { added: number; deleted: number } {
  let added = 0;
  let deleted = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) deleted += 1;
  }
  return { added, deleted };
}

export const prProposalSchema = baseSchema.superRefine((value, ctx) => {
  let totalLines = 0;
  let totalBytes = 0;
  for (const f of value.files) {
    if (f.diff) {
      const { added, deleted } = countDiffLines(f.diff);
      totalLines += added + deleted;
      totalBytes += Buffer.byteLength(f.diff, "utf-8");
    } else if (f.content) {
      const lineCount = f.content.split("\n").length;
      totalLines += lineCount;
      totalBytes += Buffer.byteLength(f.content, "utf-8");
    }
  }
  if (totalLines > TOTAL_LINE_CAP) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `pr_proposal exceeds line cap: ${totalLines} added/deleted lines > ${TOTAL_LINE_CAP}`,
      path: ["files"],
    });
  }
  if (totalBytes > TOTAL_BYTE_CAP) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `pr_proposal exceeds byte cap: ${totalBytes} > ${TOTAL_BYTE_CAP}`,
      path: ["files"],
    });
  }
});

export type PrProposal = z.infer<typeof prProposalSchema>;

export const HTML_PREVIEW_MAX_CHARS = 200 * 1024;

export const htmlPreviewDesignSpecSchema = z.object({
  components: z.array(z.string().max(160)).max(24).optional(),
  native_controls: z.array(z.string().max(160)).max(24).optional(),
  palette: z.array(z.string().max(40)).max(16).optional(),
  spacing: z.string().max(240).optional(),
  cta_states: z.string().max(400).optional(),
});
export type HtmlPreviewDesignSpec = z.infer<typeof htmlPreviewDesignSpecSchema>;

export const htmlPreviewSchema = z.object({
  kind: z.literal("html_preview"),
  variant: z.enum(["engineer_preview", "wireframe", "deck", "doc"]).optional(),
  title: z.string().max(120),
  summary: z.string().max(RENDERED_MARKDOWN_MAX_CHARS),
  html: z.string().max(HTML_PREVIEW_MAX_CHARS),
  html_before: z.string().max(HTML_PREVIEW_MAX_CHARS).optional(),
  rationale: z
    .array(
      z.object({
        change: z.string().max(200),
        why: z.string().max(500),
      }),
    )
    .max(12)
    .optional(),
  design_spec: htmlPreviewDesignSpecSchema.optional(),
});
export type HtmlPreview = z.infer<typeof htmlPreviewSchema>;

export const htmlPreviewMetadataSchema = z.object({
  version: z.literal(2),
  kind: z.literal("html_preview"),
  state: z.literal("html_preview_ready"),
  title: z.string().min(1).max(120),
  summary: z.string().max(RENDERED_MARKDOWN_MAX_CHARS),
  preview_id: z.string().uuid(),
  design_spec: htmlPreviewDesignSpecSchema.optional(),
});
export type HtmlPreviewMetadata = z.infer<typeof htmlPreviewMetadataSchema>;
export type ParsedHtmlPreview = HtmlPreview | HtmlPreviewMetadata;

export const HTML_PREVIEW_BLOCK_RE =
  /<html_preview(?:\s[^>]*)?>\s*([\s\S]*?)\s*<\/html_preview\s*>/i;

export const HTML_PREVIEW_BLOCK_RE_ALL =
  /<html_preview(?:\s[^>]*)?>\s*[\s\S]*?\s*<\/html_preview\s*>/gi;

export function hasHtmlPreviewBlock(rawText: string): boolean {
  return typeof rawText === "string" && /<html_preview(?:\s[^>]*)?>/i.test(rawText);
}

export function parseHtmlPreviewEnvelope(rawText: string): ParsedHtmlPreview | null {
  if (typeof rawText !== "string" || rawText.length === 0) return null;
  const m = rawText.match(HTML_PREVIEW_BLOCK_RE);
  if (!m) return null;
  let json: unknown;
  try {
    json = JSON.parse(m[1]);
  } catch {
    return null;
  }
  const metadata = htmlPreviewMetadataSchema.safeParse(json);
  if (metadata.success) return metadata.data;
  const legacy = htmlPreviewSchema.safeParse(json);
  return legacy.success ? legacy.data : null;
}

const PRODUCT_BUILD_TOTAL_LINE_CAP = ENGINEER_PR_CAPS_PRODUCT_BUILD.maxChangedLines;
const PRODUCT_BUILD_TOTAL_BYTE_CAP = ENGINEER_PR_CAPS_PRODUCT_BUILD.diffByteCap;
const PRODUCT_BUILD_MAX_FILES = ENGINEER_PR_CAPS_PRODUCT_BUILD.maxFiles;

const PRODUCT_BUILD_PER_FILE_DIFF_CAP = ENGINEER_PR_CAPS_PRODUCT_BUILD.diffByteCap;
const productBuildFileChangeSchema = z
  .object({
    path: z.string().min(1).max(512),
    action: z.enum(["create", "modify", "delete"]),
    content: z
      .string()
      .max(base64Chars(ENGINEER_PR_CAPS_PRODUCT_BUILD.maxPostImageBytes))
      .optional(),
    encoding: z.literal("base64").optional(),
    diff: z.string().max(PRODUCT_BUILD_PER_FILE_DIFF_CAP).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.action === "delete") {
      if (value.content !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "delete action must not include `content`",
          path: ["content"],
        });
      }
      return;
    }
    if (typeof value.content !== "string" || value.content.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${value.action} action requires non-empty 'content' (full post-image of the file)`,
        path: ["content"],
      });
    }
  });

export const prProposalProductBuildSchema = z
  .object({
    ...baseSchema.shape,
    files: z.array(productBuildFileChangeSchema).min(1).max(PRODUCT_BUILD_MAX_FILES),
  })
  .superRefine((value, ctx) => {
    let totalLines = 0;
    let totalBytes = 0;
    for (const f of value.files) {
      if (f.diff) {
        const { added, deleted } = countDiffLines(f.diff);
        totalLines += added + deleted;
        totalBytes += Buffer.byteLength(f.diff, "utf-8");
      } else if (f.content) {
        const lineCount = f.content.split("\n").length;
        totalLines += lineCount;
        totalBytes += Buffer.byteLength(f.content, "utf-8");
      }
    }
    if (totalLines > PRODUCT_BUILD_TOTAL_LINE_CAP) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `product-build pr_proposal exceeds line cap: ${totalLines} > ${PRODUCT_BUILD_TOTAL_LINE_CAP}`,
        path: ["files"],
      });
    }
    if (totalBytes > PRODUCT_BUILD_TOTAL_BYTE_CAP) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `product-build pr_proposal exceeds byte cap: ${totalBytes} > ${PRODUCT_BUILD_TOTAL_BYTE_CAP}`,
        path: ["files"],
      });
    }
  });

const PROPOSAL_REQUIRED_KEYS = ["repo", "base_branch", "title"] as const;

export const prProposalModelOutputSchema = baseSchema.omit({
  files: true,
  per_base_files: true,
  base_conflicts: true,
  wiring_unverified: true,
  wiring_unwired_symbols: true,
  http_route_changed: true,
  carried_constants: true,
  completeness_unverified: true,
  verification_notes: true,
  protected_paths: true,
})
  .partial({ head_branch: true, repo: true, base_branch: true, title: true })
  .extend({
    reason_code: z.literal("no_change").optional(),
  })
  .superRefine((value, ctx) => {
    if (value.reason_code === "no_change") {
      if (typeof value.customer_summary !== "string" || value.customer_summary.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'reason_code "no_change" requires a non-empty customer_summary',
          path: ["customer_summary"],
        });
      }
      return;
    }
    for (const key of PROPOSAL_REQUIRED_KEYS) {
      if (value[key] === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Invalid input: expected string, received undefined",
          path: [key],
        });
      }
    }
  });
export type PrProposalModelOutput = z.infer<typeof prProposalModelOutputSchema>;

export const __caps = { TOTAL_LINE_CAP, TOTAL_BYTE_CAP, countDiffLines };

export type DispatchValidationResult =
  | { ok: true }
  | {
      ok: false;
      reason: string;
      over_cap: boolean;
    };

export function validateProposalForDispatch(
  body: unknown,
  opts: { productBuild: boolean },
): DispatchValidationResult {
  const schema = opts.productBuild ? prProposalProductBuildSchema : prProposalSchema;
  const parsed = schema.safeParse(body);
  if (parsed.success) return { ok: true };
  const issues = parsed.error.issues;
  const over_cap = issues.some(
    (i) =>
      /exceeds (line|byte) cap/.test(i.message) ||
      (i.code === "too_big" && i.path[0] === "files" && i.path.length === 1),
  );
  return {
    ok: false,
    reason: issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ")
      .slice(0, 1500),
    over_cap,
  };
}
