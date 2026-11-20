
import { createHash } from "node:crypto";
import { z } from "zod";
import { countBatch, listBatch, parseRowList, reconcileLinks, type ListedInvite } from "@/services/creators/creator-invites";
import {
  inviteSignupUrl,
  renderInvite,
  runInviteSend,
  selectInviteRows,
  sheetRowOf,
  type SendTally,
} from "@/services/creators/creator-invite-send";
import { BATCH_RE, planUpload, type UploadPlan } from "@/services/creators/creator-invite-upload";
import {
  EXEC_FAILURES_SORT_KEY,
  listFailedOpen,
  previewExecFailureSort,
  resumeCursor,
  runExecFailureSort,
  sortConfirmPhrase,
  stampVerdict,
} from "./exec-failures-sort";
import {
  CARD_CHAIN_KEY,
  DEFAULT_CHAIN_DEPS,
  chainConfirmPhrase,
  chainResumeState,
  previewCardChain,
  runCardChain,
} from "./card-chain";
import {
  applyNameFix,
  DEFAULT_SITE_NAME_FIX_DEPS,
  prepareNameFix,
  previewNameFix,
  SITE_NAME_FIX_KEY,
  SiteNameFixError,
  siteNameFixSchema,
  type SiteNameFixArgs,
} from "./site-name-fix";
import {
  applySmokeHooks,
  DEFAULT_SMOKE_HOOKS_DEPS,
  previewSmokeHooks,
  SITE_SMOKE_HOOKS_KEY,
  SMOKE_HOOKS_CONFIRM,
  smokeHooksSchema,
  SmokeHooksError,
  type SmokeHooksArgs,
} from "./site-smoke-hooks";
import {
  applyBuildContinue,
  BUILD_CONTINUE_KEY,
  BuildContinueNotFound,
  buildContinueSchema,
  continueConfirmPhrase,
  DEFAULT_BUILD_CONTINUE_DEPS,
  previewBuildContinue,
  type BuildContinueArgs,
} from "./build-continue";
import {
  applyClearHold,
  applyResumeSend,
  BULK_CLEAR_HOLD_KEY,
  BULK_RESUME_SEND_KEY,
  BulkScriptError,
  clearHoldConfirmPhrase,
  clearHoldSchema,
  DEFAULT_BULK_SCRIPT_DEPS,
  previewClearHold,
  previewResumeSend,
  resumeConfirmPhrase,
  resumeSendSchema,
  type ClearHoldArgs,
  type ResumeSendArgs,
} from "./bulk-email";
import {
  convergePlatformWorkerSecrets,
  productionWorkerSecretsAlert,
  type ConvergeResult,
} from "@/services/hosting/platform-worker-secrets";

export type FieldMeta = {
  name: string;
  type: "string" | "number" | "boolean" | "file";
  label: string;
  help?: string;
  placeholder?: string;
  required?: boolean;
  default?: string | number | boolean;
  accept?: string;
};

export type UploadedFile = { name: string; bytes: number; text: string };

export type ScriptContext = {
  staff: { user_id: string; email: string };
  env: Record<string, string | undefined>;
  file?: UploadedFile;
};

export type PreparedApply = {
  execute: (progress: (p: Record<string, unknown>) => Promise<void>) => Promise<{ summary: Record<string, unknown>; result: unknown }>;
};

export class ScriptInputError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export type AdminScript<A = Record<string, unknown>> = {
  key: string;
  group: string;
  label: string;
  description: string;
  fields: FieldMeta[];
  schema: z.ZodType<A>;
  needsFile?: boolean;
  applies: boolean;
  longRunning: boolean;
  confirmHint?: string;
  lockKey: (a: A) => string;
  storedArgs: (a: A, ctx: ScriptContext) => Record<string, unknown>;
  dryRun: (a: A, ctx: ScriptContext) => Promise<unknown>;
  prepareApply?: (a: A, ctx: ScriptContext, confirm: string | undefined, previewToken?: string) => Promise<PreparedApply>;
};

const batchField: FieldMeta = {
  name: "batch",
  type: "string",
  label: "Batch",
  required: true,
  placeholder: "creators-prod-2026-09",
  help: "Letters, digits, - and _. Use the same batch for upload, list and send.",
};

const batchSchema = z.string().trim().regex(BATCH_RE, "batch: letters, digits, - and _ only (max 64)");

const optionalPositiveInt = z.preprocess(
  (v) => (v === "" || v === null || v === undefined ? undefined : typeof v === "string" ? Number(v) : v),
  z.number().int().positive().optional(),
);
const boolish = z.preprocess((v) => v === true || v === "true" || v === "on" || v === "1", z.boolean());

function requireFile(ctx: ScriptContext): UploadedFile {
  if (!ctx.file) throw new ScriptInputError("file_required", "Choose the creators CSV file.");
  return ctx.file;
}

function expectConfirm(confirm: string | undefined, expected: string): void {
  if ((confirm ?? "").trim() !== expected) {
    throw new ScriptInputError("confirm_mismatch", `Type "${expected}" to confirm.`, 409, { expected });
  }
}

type UploadArgs = { batch: string; limit?: number };

function uploadDto(plan: UploadPlan) {
  const r = plan.report;
  return {
    sheet: {
      rows_read: r.rowsRead,
      blank_rows: r.blankRows,
      errors: r.errors.map((e) => ({ sheet_row: e.sheetRow, reason: e.reason })),
      sheet_duplicates: r.sheetDuplicates,
      same_email_duplicates: r.sameEmailDuplicates,
      source_key_duplicates: r.sourceKeyDuplicates,
      duplicate_review: r.duplicateReview,
      shared_domains: r.sharedDomains,
    },
    rows: plan.rowCount,
    with_email: plan.withEmail,
    holds: plan.holds,
    in_conversation: plan.inConversation,
    has_account_rows: plan.hasAccountRows,
    invitable_now: plan.invitableNow,
    invitable_with_conversation: plan.invitableWithConversation,
    limit: plan.limit,
    loaded: plan.limit === null ? null : plan.loaded.map((x) => ({ sheet_row: x.sheetRow, name: x.displayName })),
    result: plan.result && {
      inserted: plan.result.inserted,
      updated: plan.result.updated,
      email_conflicts: plan.result.emailConflicts,
      skipped_deleted: plan.result.skippedDeleted,
    },
    missing_email_csv: plan.missingEmailCsv,
  };
}

const creatorUpload: AdminScript<UploadArgs> = {
  key: "creator-upload",
  group: "Creator invites",
  label: "Upload creators",
  description:
    "Saves creators from the outreach sheet CSV into the database. Sends NO email. Duplicates, agencies, EU/UK addresses, prior bounces and people who already have a Zavi account are set aside. Re-uploading the same sheet adds nothing new. The file itself is not stored.",
  fields: [
    { name: "file", type: "file", label: "Creators CSV", required: true, accept: ".csv,text/csv" },
    batchField,
    { name: "limit", type: "number", label: "Limit (optional)", help: "Load only the first N invitable creators, to check them first." },
  ],
  schema: z.object({ batch: batchSchema, limit: optionalPositiveInt }) as z.ZodType<UploadArgs>,
  needsFile: true,
  applies: true,
  longRunning: false,
  confirmHint: "APPLY",
  lockKey: (a) => a.batch,
  storedArgs: (a, ctx) => ({ batch: a.batch, limit: a.limit ?? null, file_bytes: ctx.file?.bytes ?? null }),
  async dryRun(a, ctx) {
    const file = requireFile(ctx);
    return uploadDto(await planUpload({ csvText: file.text, batch: a.batch, limit: a.limit ?? null, apply: false }));
  },
  async prepareApply(a, ctx, confirm) {
    const file = requireFile(ctx);
    expectConfirm(confirm, "APPLY");
    return {
      async execute() {
        const plan = await planUpload({ csvText: file.text, batch: a.batch, limit: a.limit ?? null, apply: true });
        const dto = uploadDto(plan);
        return {
          result: dto,
          summary: {
            rows: dto.rows,
            inserted: dto.result?.inserted ?? 0,
            updated: dto.result?.updated ?? 0,
            email_conflicts: dto.result?.email_conflicts.length ?? 0,
            invitable_now: dto.invitable_now,
          },
        };
      },
    };
  },
};

type ListArgs = { batch: string; show_emails: boolean };

function listedDto(r: ListedInvite, showEmails: boolean) {
  return {
    sheet_row: r.source_meta?.sheet_row ?? null,
    name: r.display_name,
    email: showEmails ? r.email : null,
    has_email: !!r.email,
    label: r.label,
    hold_reason: r.hold_reason,
    in_conversation: r.in_conversation,
    profiles: Object.entries(r.profiles ?? {}).map(([p, v]) => `${p}:${v?.handle ?? v?.url ?? "?"}`),
    followers: Object.entries(r.followers ?? {}).map(([p, v]) => `${p}=${v?.n ?? v?.raw ?? "?"}`),
  };
}

const creatorList: AdminScript<ListArgs> = {
  key: "creator-list",
  group: "Creator invites",
  label: "List creators",
  description: "Shows every creator in a batch with their status. Read-only. Emails are hidden unless you tick Show emails (that view is audit-logged).",
  fields: [batchField, { name: "show_emails", type: "boolean", label: "Show emails", default: false }],
  schema: z.object({ batch: batchSchema, show_emails: boolish }) as z.ZodType<ListArgs>,
  applies: false,
  longRunning: false,
  lockKey: (a) => a.batch,
  storedArgs: (a) => ({ batch: a.batch, show_emails: a.show_emails }),
  async dryRun(a) {
    const rows = await listBatch(a.batch);
    const by_label: Record<string, number> = {};
    for (const r of rows) by_label[r.label] = (by_label[r.label] ?? 0) + 1;
    return { batch: a.batch, total: rows.length, by_label, rows: rows.map((r) => listedDto(r, a.show_emails)) };
  },
};

export function recipientsFingerprint(ids: readonly string[]): string {
  return createHash("sha256").update(ids.join("\n")).digest("hex").slice(0, 32);
}

type SendArgs = { batch: string; max: number; rows: number[]; retry_failed: boolean };

const rowsSchema = z.preprocess(
  (v) => (typeof v === "string" ? v.trim() : v),
  z
    .string()
    .optional()
    .transform((raw, zctx) => {
      if (!raw) return [] as number[];
      try {
        return parseRowList(raw, "rows");
      } catch (e) {
        zctx.addIssue({ code: "custom", message: (e as Error).message });
        return z.NEVER;
      }
    }),
);

async function ensureBatch(batch: string): Promise<void> {
  if ((await countBatch(batch)) === 0) {
    throw new ScriptInputError("empty_batch", `Batch "${batch}" has no rows. Upload creators with that batch first.`, 404);
  }
}

const creatorSend: AdminScript<SendArgs> = {
  key: "creator-send",
  group: "Creator invites",
  label: "Send invites",
  description:
    "Emails each eligible creator in the batch ONE invite, ever. Dry Run shows who would be emailed and checks the settings; nothing is sent. Apply sends in the background (about 0.6s per email). Re-running never emails anyone twice. Only EU/UK email domains are filtered: the sheet has no country column.",
  fields: [
    batchField,
    { name: "max", type: "number", label: "Max to send", default: 100, help: "Caps this run. Ignored when Rows is set." },
    { name: "rows", type: "string", label: "Rows", placeholder: "all", help: "Refs from the Dry Run, comma separated. Leftover rows are never deleted by this tool (flag no_provenance)." },
    { name: "retry_failed", type: "boolean", label: "Retry failed", default: false, help: "Retry rows SendGrid rejected last time." },
  ],
  schema: z.object({
    batch: batchSchema,
    max: z.preprocess((v) => (v === "" || v === undefined || v === null ? 100 : typeof v === "string" ? Number(v) : v), z.number().int().min(1).max(1000)),
    rows: rowsSchema,
    retry_failed: boolish,
  }) as unknown as z.ZodType<SendArgs>,
  applies: true,
  longRunning: true,
  confirmHint: "SEND <count>",
  lockKey: () => "*",
  storedArgs: (a) => ({ batch: a.batch, max: a.max, rows: a.rows.length ? `${a.rows.length} row(s)` : null, retry_failed: a.retry_failed }),
  async dryRun(a, ctx) {
    await ensureBatch(a.batch);
    const res = await runInviteSend({
      batch: a.batch,
      max: a.max,
      rows: a.rows,
      retry: a.retry_failed,
      includeInConversation: false,
      apply: false,
      acknowledgedNoGeo: true,
      env: ctx.env,
    });
    const sample = res.toSend[0] ? (() => {
      try {
        const mail = renderInvite({ display_name: res.toSend[0].display_name, unsub_token: "preview" }, res.links);
        return { subject: mail.subject, signup_url: `${inviteSignupUrl(res.links.web)}&invite=<per-creator token>`, unsubscribe_url: `${res.links.api}/api/creators/invite/unsubscribe?t=<per-creator token>` };
      } catch {
        return null;
      }
    })() : null;
    return {
      batch: a.batch,
      eligible: res.eligibleCount,
      would_send: res.toSend.map((r) => ({ sheet_row: sheetRowOf(r), name: r.display_name })),
      skipped: res.skipped.map((s) => ({ sheet_row: s.sheetRow, name: s.name, reason: s.reason })),
      problems: res.problems,
      sender: res.sender,
      sample,
      confirm_phrase: `SEND ${res.toSend.length}`,
      preview_token: recipientsFingerprint(res.toSend.map((r) => r.id)),
    };
  },
  async prepareApply(a, ctx, confirm, previewToken) {
    await ensureBatch(a.batch);
    const selected = await selectInviteRows({ batch: a.batch, max: a.max, rows: a.rows, retry: a.retry_failed, includeInConversation: false, apply: false });
    if (selected.toSend.length === 0) throw new ScriptInputError("nothing_to_send", "No eligible creators to email in this batch.", 409);
    if (!previewToken || previewToken !== recipientsFingerprint(selected.toSend.map((r) => r.id))) {
      throw new ScriptInputError("list_changed", "Who would be emailed changed since the Dry Run. Run the Dry Run again and check the list.", 409);
    }
    expectConfirm(confirm, `SEND ${selected.toSend.length}`);
    return {
      async execute(progress) {
        await reconcileLinks();
        const res = await runInviteSend({
          batch: a.batch,
          max: a.max,
          rows: a.rows,
          retry: a.retry_failed,
          includeInConversation: false,
          apply: true,
          acknowledgedNoGeo: true,
          env: ctx.env,
          preselected: selected.toSend,
          onProgress: (t: SendTally) => progress({ ...t }),
        });
        const summary = { ...res.tally, stopped: res.stoppedReason };
        return { summary, result: summary };
      },
    };
  },
};

type SortArgs = { reclassify: boolean; resume: boolean };

const channelExecFailuresSort: AdminScript<SortArgs> = {
  key: EXEC_FAILURES_SORT_KEY,
  group: "Channel cards",
  label: "Re-sort failed cards",
  description:
    "Runs today's failure sorter over every failed channel card that is still open. Cards with no verdict are stamped; with Re-classify, cards whose verdict changed are re-stamped. A card the platform refused closes and alerts Zavi once; nothing is ever re-opened. Dry Run changes nothing. The migration already sorted every card, so Remaining should read 0.",
  fields: [
    { name: "reclassify", type: "boolean", label: "Re-classify", default: false, help: "Also re-stamp cards whose stored verdict differs from today's sorter." },
    { name: "resume", type: "boolean", label: "Resume", default: false, help: "Continue from where the last failed run stopped." },
  ],
  schema: z.object({ reclassify: boolish, resume: boolish }) as unknown as z.ZodType<SortArgs>,
  applies: true,
  longRunning: true,
  confirmHint: "SORT <count>",
  lockKey: () => "*",
  storedArgs: (a) => ({ reclassify: a.reclassify, resume: a.resume }),
  async dryRun(a) {
    const preview = await previewExecFailureSort({ reclassify: a.reclassify }, listFailedOpen);
    return { ...preview, confirm_phrase: sortConfirmPhrase(preview, a.reclassify) };
  },
  async prepareApply(a, _ctx, confirm, previewToken) {
    const preview = await previewExecFailureSort({ reclassify: a.reclassify }, listFailedOpen);
    const count = preview.remaining + (a.reclassify ? preview.differing : 0);
    if (count === 0) throw new ScriptInputError("nothing_to_sort", "Every failed open card already carries today's verdict.", 409);
    if (!previewToken || previewToken !== preview.preview_token) {
      throw new ScriptInputError("list_changed", "The cards to sort changed since the Dry Run. Run the Dry Run again.", 409);
    }
    expectConfirm(confirm, sortConfirmPhrase(preview, a.reclassify));
    const cursor = a.resume ? await resumeCursor() : null;
    return {
      async execute(progress) {
        const out = await runExecFailureSort(
          { cursor, reclassify: a.reclassify },
          { list: listFailedOpen, stamp: stampVerdict, progress: (p) => progress({ ...p }) },
        );
        const summary = { processed: out.processed, stamped: out.stamped, closed: out.closed, skipped: out.skipped, differing: out.differing, failed: out.failed_count };
        return { summary, result: { ...summary, errors: out.errors } };
      },
    };
  },
};

type ChainArgs = { use_matcher: boolean; max_channels: number; resume: boolean };

const channelCardChain: AdminScript<ChainArgs> = {
  key: CARD_CHAIN_KEY,
  group: "Channel cards",
  label: "Chain duplicate cards",
  description:
    "Gives cards filed before layered dedupe what new cards get at birth: stamps their target key, then retires each untouched exact twin behind its newest copy and links the two (repeat_of). With Use matcher, also asks the matcher about the newest card on each target. A card the founder touched is never retired. Dry Run changes nothing and calls no model; it should read Pairs 0 and Keys missing 0 once done.",
  fields: [
    { name: "use_matcher", type: "boolean", label: "Use matcher", default: false, help: "Also judge same-target cards with the matcher (one Haiku call per target)." },
    { name: "max_channels", type: "number", label: "Max channels", default: 500, help: "Stop after this many channels; Resume continues from there." },
    { name: "resume", type: "boolean", label: "Resume", default: false, help: "Continue from where the last unfinished run stopped." },
  ],
  schema: z.object({
    use_matcher: boolish,
    max_channels: z.preprocess(
      (v) => (v === "" || v === null || v === undefined ? 500 : typeof v === "string" ? Number(v) : v),
      z.number().int().min(1).max(100_000),
    ),
    resume: boolish,
  }) as unknown as z.ZodType<ChainArgs>,
  applies: true,
  longRunning: true,
  confirmHint: "CHAIN <pairs> (with the matcher: CHAIN <pairs> JUDGE <targets>)",
  lockKey: () => "*",
  storedArgs: (a) => ({ use_matcher: a.use_matcher, max_channels: a.max_channels, resume: a.resume }),
  async dryRun(a) {
    const preview = await previewCardChain({ useMatcher: a.use_matcher }, DEFAULT_CHAIN_DEPS);
    return { ...preview, confirm_phrase: chainConfirmPhrase(preview, a.use_matcher) };
  },
  async prepareApply(a, _ctx, confirm, previewToken) {
    const preview = await previewCardChain({ useMatcher: a.use_matcher }, DEFAULT_CHAIN_DEPS);
    if (preview.pairs === 0 && preview.keys_missing === 0 && !(a.use_matcher && preview.model_calls_estimate > 0)) {
      throw new ScriptInputError("nothing_to_chain", "Every open card is keyed and no exact twins are left.", 409);
    }
    if (!previewToken || previewToken !== preview.preview_token) {
      throw new ScriptInputError("list_changed", "The cards to chain changed since the Dry Run. Run the Dry Run again.", 409);
    }
    expectConfirm(confirm, chainConfirmPhrase(preview, a.use_matcher));
    const resumeFrom = a.resume ? await chainResumeState() : { cursor: null, truncated: 0 };
    return {
      async execute(progress) {
        const out = await runCardChain(
          { cursor: resumeFrom.cursor, truncated: resumeFrom.truncated, useMatcher: a.use_matcher, maxChannels: a.max_channels },
          { ...DEFAULT_CHAIN_DEPS, progress: (p) => progress({ ...p }) },
        );
        const summary = {
          channels: out.channels,
          keys_stamped: out.keys_stamped,
          chained: out.chained,
          unlinked: out.unlinked,
          truncated: out.truncated,
          refused: out.refused,
          model_calls: out.model_calls,
          input_tokens: out.input_tokens,
          complete: out.complete,
          failed: out.failed_count,
        };
        return { summary, result: { ...summary, output_tokens: out.output_tokens, cursor: out.cursor, errors: out.errors } };
      },
    };
  },
};

async function asInput<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof SiteNameFixError || e instanceof SmokeHooksError) throw new ScriptInputError(e.code, e.message, e.status);
    throw e;
  }
}

const siteNameFix: AdminScript<SiteNameFixArgs> = {
  key: SITE_NAME_FIX_KEY,
  group: "Websites",
  label: "Fix a site's display name",
  description:
    "Recomputes a site's name the way new sites are named (\"&\" decoded, no workspace hash or site id) from the site's own build request, or stores the name you type. Dry Run shows the name now and after; it changes nothing. Apply changes only the stored name: the Build header, Artifacts and the site-is-live email show it. The address (hostname) never changes, and the live site's own page title and share tags stay as they are until the site is edited and published again.",
  fields: [
    { name: "site_id", type: "string", label: "Site id", required: true, placeholder: "site uuid" },
    { name: "name", type: "string", label: "Name (optional)", placeholder: "Rise & Shine Bakery", help: "Leave empty to derive it. Typed names are checked like any site name." },
  ],
  schema: siteNameFixSchema as unknown as z.ZodType<SiteNameFixArgs>,
  applies: true,
  longRunning: false,
  confirmHint: "RENAME <the full site id>",
  lockKey: (a) => a.site_id,
  storedArgs: (a) => ({ site_id: a.site_id, typed_name: a.name !== undefined }),
  dryRun: (a) => asInput(() => previewNameFix(a, DEFAULT_SITE_NAME_FIX_DEPS)),
  async prepareApply(a, _ctx, confirm, previewToken) {
    const preview = await asInput(() => prepareNameFix(a, DEFAULT_SITE_NAME_FIX_DEPS, confirm, previewToken));
    return {
      async execute() {
        const outcome = await asInput(() => applyNameFix(preview, DEFAULT_SITE_NAME_FIX_DEPS));
        const summary = { site_id: preview.site_id, tenant_id: preview.tenant_id, outcome, source: preview.source };
        return { summary, result: { ...summary, name: preview.new_name, hostname: preview.hostname } };
      },
    };
  },
};

const siteSmokeHooks: AdminScript<SmokeHooksArgs> = {
  key: SITE_SMOKE_HOOKS_KEY,
  group: "Websites",
  label: "Remove leftover publish-check triggers",
  description:
    "One-time cleanup. The publish check used to arm a log (three triggers + two tables) on a dedicated site's own database to delete its test rows; it now tests on a throwaway site and arms nothing. Dry Run lists, a page of sites at a time (or one site), what is still on each database; it changes nothing. Apply removes only those platform-made objects (never a site's own trigger) and re-reads each site. Safe to run again.",
  fields: [
    { name: "site_id", type: "string", label: "Site id (optional)", placeholder: "site uuid", help: "Empty = a page of every site with its own database." },
    { name: "max_sites", type: "number", label: "Max sites", default: 50, help: "Sites per page (max 200)." },
    { name: "after", type: "string", label: "After (optional)", help: "Continue after this site id (the previous run's next_after)." },
  ],
  schema: smokeHooksSchema as unknown as z.ZodType<SmokeHooksArgs>,
  applies: true,
  longRunning: true,
  confirmHint: SMOKE_HOOKS_CONFIRM,
  lockKey: () => SITE_SMOKE_HOOKS_KEY,
  storedArgs: (a) => ({ site_id: a.site_id ?? null, max_sites: a.max_sites, after: a.after ?? null }),
  dryRun: (a) => asInput(() => previewSmokeHooks(a, DEFAULT_SMOKE_HOOKS_DEPS)),
  async prepareApply(a, _ctx, confirm) {
    if ((confirm ?? "").trim() !== SMOKE_HOOKS_CONFIRM) {
      throw new ScriptInputError("confirm_mismatch", `Type ${SMOKE_HOOKS_CONFIRM} to remove them.`);
    }
    return {
      async execute(progress) {
        const out = await asInput(() => applySmokeHooks(a, confirm, DEFAULT_SMOKE_HOOKS_DEPS, progress));
        const summary = { scanned: out.scanned, removed: out.removed, left: out.left, next_after: out.next_after };
        if (out.left > 0) {
          throw new ScriptInputError(
            "cleanup_incomplete",
            `${out.removed} cleaned, ${out.left} site(s) not clean: ${out.sites.map((s) => `${s.site_id}${s.ok ? "" : ` (${s.error})`}`).join("; ")}`.slice(0, 500),
            502,
          );
        }
        return { summary, result: out };
      },
    };
  },
};

const buildContinue: AdminScript<BuildContinueArgs> = {
  key: BUILD_CONTINUE_KEY,
  group: "Website builds",
  label: "Continue a stuck build",
  description:
    "Resumes a customer's paused website build (for example a publish that failed) exactly as their own Continue / Retry publish button would, in the build's own workspace. Dry Run shows the build, its site and whether it can resume; it changes nothing. Apply spends from that build's own budget, like the customer's click.",
  fields: [
    { name: "run_id", type: "string", label: "Build id", required: true, placeholder: "conductor run uuid", help: "The build's conductor run id (sites.root_conductor_run_id)." },
  ],
  schema: buildContinueSchema as unknown as z.ZodType<BuildContinueArgs>,
  applies: true,
  longRunning: false,
  confirmHint: "CONTINUE <the full build id>",
  lockKey: (a) => a.run_id,
  storedArgs: (a) => ({ run_id: a.run_id }),
  async dryRun(a) {
    try {
      return await previewBuildContinue(a.run_id, DEFAULT_BUILD_CONTINUE_DEPS);
    } catch (e) {
      if (e instanceof BuildContinueNotFound) throw new ScriptInputError("not_found", e.message, 404);
      throw e;
    }
  },
  async prepareApply(a, _ctx, confirm) {
    expectConfirm(confirm, continueConfirmPhrase(a.run_id));
    return {
      async execute() {
        try {
          const { build, result } = await applyBuildContinue(a.run_id, DEFAULT_BUILD_CONTINUE_DEPS);
          if (!result.ok) throw new ScriptInputError(result.code, result.message, 409);
          const summary = { ...result, tenant_id: build.tenant_id, site_id: build.site?.id ?? null };
          return { summary, result: summary };
        } catch (e) {
          if (e instanceof BuildContinueNotFound) throw new ScriptInputError("not_found", e.message, 404);
          throw e;
        }
      },
    };
  },
};

function asScriptError(e: unknown): never {
  if (e instanceof BulkScriptError) throw new ScriptInputError(e.code, e.message, e.status);
  throw e;
}

const bulkClearHold: AdminScript<ClearHoldArgs> = {
  key: BULK_CLEAR_HOLD_KEY,
  group: "Bulk email",
  label: "Clear an abuse hold",
  description:
    "A workspace whose bulk send hit the spam-complaint or bounce rule is on hold: no bulk email goes out. Dry Run shows the hold. Apply clears it, and switches bulk email back on only if the abuse shutoff is what switched it off (a switch-off by staff or the founder is left alone, and the result says so). Held sends stay held; resume each one separately.",
  fields: [{ name: "tenant_id", type: "string", label: "Workspace id", required: true, placeholder: "tenant uuid" }],
  schema: clearHoldSchema as unknown as z.ZodType<ClearHoldArgs>,
  applies: true,
  longRunning: false,
  confirmHint: "CLEAR HOLD <the full workspace id>",
  lockKey: (a) => a.tenant_id,
  storedArgs: (a) => ({ tenant_id: a.tenant_id }),
  async dryRun(a) {
    return previewClearHold(a, DEFAULT_BULK_SCRIPT_DEPS).catch(asScriptError);
  },
  async prepareApply(a, ctx, confirm) {
    expectConfirm(confirm, clearHoldConfirmPhrase(a.tenant_id));
    return {
      async execute() {
        const summary = await applyClearHold(a, ctx.staff, DEFAULT_BULK_SCRIPT_DEPS).catch(asScriptError);
        return { summary, result: summary };
      },
    };
  },
};

const bulkResumeSend: AdminScript<ResumeSendArgs> = {
  key: BULK_RESUME_SEND_KEY,
  group: "Bulk email",
  label: "Resume a held bulk send",
  description:
    "Continues ONE held bulk email from where it stopped. Only people still waiting are emailed; nobody it already reached (sent, in flight or unconfirmed) is emailed again. Only sends held for spam reports or bounces (after the hold is cleared), a provider refusal, or a check that could not be read can be resumed; the domain, list, consent and switches are checked again first. Every safety check also runs before each batch.",
  fields: [{ name: "send_id", type: "string", label: "Send id", required: true, placeholder: "email_bulk_sends uuid" }],
  schema: resumeSendSchema as unknown as z.ZodType<ResumeSendArgs>,
  applies: true,
  longRunning: false,
  confirmHint: "RESUME <the full send id>",
  lockKey: (a) => a.send_id,
  storedArgs: (a) => ({ send_id: a.send_id }),
  async dryRun(a) {
    return previewResumeSend(a, DEFAULT_BULK_SCRIPT_DEPS).catch(asScriptError);
  },
  async prepareApply(a, _ctx, confirm) {
    expectConfirm(confirm, resumeConfirmPhrase(a.send_id));
    return {
      async execute() {
        const summary = await applyResumeSend(a, DEFAULT_BULK_SCRIPT_DEPS).catch(asScriptError);
        return { summary, result: summary };
      },
    };
  },
};

export const PLATFORM_WORKER_SECRETS_KEY = "platform-worker-secrets";
export const PLATFORM_WORKER_SECRETS_CONFIRM = "CONVERGE WORKER SECRETS";
type WorkerSecretsArgs = { force: boolean };

function workerSecretsSummary(r: ConvergeResult): Record<string, unknown> {
  if (r.skipped) return { skipped: r.skipped, missing: r.missing };
  return { ok: r.ok, ...r.counts, workers: r.workers, secrets: r.secrets };
}

const platformWorkerSecrets: AdminScript<WorkerSecretsArgs> = {
  key: PLATFORM_WORKER_SECRETS_KEY,
  group: "Websites",
  label: "Sync platform Worker secrets",
  description:
    "Writes the site Workers' secrets (preview, wake, auth broker, site functions) from this backend's own settings into Cloudflare. The backend also does this at every start. Dry Run lists, per Worker, which secrets would be written and why; it changes nothing. Apply writes only the ones that differ from what the backend last wrote (each write is a new Worker version). Force rewrites every one, for a value someone changed by hand in Cloudflare. Values are never shown.",
  fields: [{ name: "force", type: "boolean", label: "Force", default: false, help: "Rewrite every secret even if unchanged." }],
  schema: z.object({ force: boolish.default(false) }) as unknown as z.ZodType<WorkerSecretsArgs>,
  applies: true,
  longRunning: false,
  confirmHint: PLATFORM_WORKER_SECRETS_CONFIRM,
  lockKey: () => PLATFORM_WORKER_SECRETS_KEY,
  storedArgs: (a) => ({ force: a.force }),
  async dryRun(a, ctx) {
    return workerSecretsSummary(await convergePlatformWorkerSecrets({ dryRun: true, force: a.force }, { env: ctx.env }));
  },
  async prepareApply(a, ctx, confirm) {
    if (ctx.env.PRAXIS_CONTAINER_ROLE !== "canonical") {
      throw new ScriptInputError("not_canonical", "Apply runs only on the deployed backend (canonical container). Dry Run works anywhere.", 409);
    }
    expectConfirm(confirm, PLATFORM_WORKER_SECRETS_CONFIRM);
    return {
      async execute() {
        const out = await convergePlatformWorkerSecrets({ force: a.force }, { env: ctx.env, alert: productionWorkerSecretsAlert });
        const summary = workerSecretsSummary(out);
        if (out.skipped) throw new ScriptInputError("not_configured", `Cloudflare is not configured: missing ${out.missing.join(", ")}`, 409);
        if (!out.ok) {
          const bad = [
            ...out.workers.filter((w) => w.status !== "ok").map((w) => `${w.worker}: ${w.status}${w.error ? ` (${w.error})` : ""}`),
            ...out.secrets.filter((s) => s.error).map((s) => `${s.worker}/${s.secret}: ${s.error}`),
          ];
          throw new ScriptInputError("not_converged", `${out.counts.put} written; not converged: ${bad.join("; ")}`.slice(0, 500), 502);
        }
        return { summary, result: summary };
      },
    };
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const SCRIPTS: readonly AdminScript<any>[] = [creatorUpload, creatorList, creatorSend, channelExecFailuresSort, channelCardChain, buildContinue, siteNameFix, siteSmokeHooks, platformWorkerSecrets, bulkClearHold, bulkResumeSend];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getScript(key: string): AdminScript<any> | undefined {
  return SCRIPTS.find((s) => s.key === key);
}

export function listScripts() {
  return SCRIPTS.map((s) => ({
    key: s.key,
    group: s.group,
    label: s.label,
    description: s.description,
    fields: s.fields,
    applies: s.applies,
    long_running: s.longRunning,
    confirm_hint: s.confirmHint ?? null,
  }));
}
