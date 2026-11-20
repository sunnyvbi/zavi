
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import {
  allowSiteInlineWrite,
  isSafeSelector,
  patchIsEmpty,
  sanitizePatch,
  sanitizeSegments,
  upsertWebsiteEdit,
  sanitizeBefore,
  withBefore,
  MAX_RUN_CHARS,
  type StoredEditPatch,
} from "./website-edits";
import {
  isStyleOnlyAsk,
  resolveInlineEdit,
  resolveChatEditFromOutline,
  type OutlineEl,
} from "@/services/website-edits/resolve-inline-edit";
import { quotaRefusal, takeInlineEditCall } from "@/services/website-edits/inline-edit-quota";
import { elementScopedRequest, isStructuralElementAsk } from "@/services/sites/site-edit-route";

type StoredReply = { status: number; body: unknown };
import { buildCompanyFactSheet } from "@/services/agents/company-fact-sheet";
import { sanitizeFetchedContent, xmlEscapeContent } from "@/services/onboarding/enrichment/sanitize";
import { getBoolSetting } from "@/services/settings";

const MAX_MESSAGE = 500;
export const NEEDS_SITE_CHANGE_CODE = "needs_site_change";
export const NEEDS_SITE_CHANGE_CHAT =
  "That's more than a change to this element, so it needs a change to the site itself. It takes a minute or two and waits in your preview until you publish.";
const TOO_MUCH_TEXT =
  "This block has no text of its own, or too much to polish at once. I can change its background here. For the words, click a smaller part of it, like a card, heading or paragraph.";
const RESOLVE_FAILED: StoredReply = {
  status: 502,
  body: { error: { code: "resolve_failed", chat: "I couldn't work that out just now - try again in a moment." } },
};
const WRITE_FAILED: StoredReply = {
  status: 500,
  body: { error: { code: "write_failed", chat: "We couldn't save that change. Try again." } },
};

async function cleanInstruction(message: string, tenant_id: string): Promise<string> {
  const plain = sanitizeFetchedContent(message);
  const jsonPlain = await getBoolSetting("website_edit_plain_instruction", tenant_id).catch(() => false);
  return jsonPlain ? plain : xmlEscapeContent(plain);
}

const KEY_RE = /^[A-Za-z0-9_.:-]{8,200}$/;

function hasIdempotencyKey(req: Request): boolean {
  const header = req.headers?.["idempotency-key"];
  return typeof header === "string" && KEY_RE.test(header);
}

function logInternal(where: string, tenant_id: string, e: unknown): void {
  console.warn(JSON.stringify({ evt: "website_inline_edit_failed", where, tenant_id, error: String((e as Error)?.message ?? e).slice(0, 300) }));
}

async function runMetered(res: Response, tenant_id: string, app_id: string, compute: () => Promise<StoredReply>): Promise<void> {
  const take = await takeInlineEditCall(tenant_id, app_id);
  if (take !== "ok") {
    const r = quotaRefusal(take);
    res.status(r.status).json(r.body);
    return;
  }
  let reply: StoredReply;
  try {
    reply = await compute();
  } catch (e) {
    logInternal("compute", tenant_id, e);
    reply = RESOLVE_FAILED;
  }
  res.status(reply.status).json(reply.body);
}

function missingKey(res: Response): void {
  res.status(400).json({ error: { code: "missing_idempotency_key", message: "an Idempotency-Key header is required" } });
}

export async function resolveWebsiteEditHandler(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const body = (req.body ?? {}) as {
    app_id?: unknown;
    selector?: unknown;
    tag?: unknown;
    text?: unknown;
    style?: unknown;
    attrs?: unknown;
    segments?: unknown;
    sparse?: unknown;
    message?: unknown;
    path?: unknown;
  };

  const app_id = typeof body.app_id === "string" ? body.app_id : "";
  if (!app_id) {
    res.status(400).json({ error: { code: "missing_app", message: "app_id is required" } });
    return;
  }
  if (!(await allowSiteInlineWrite(auth, app_id, res))) return;
  if (!isSafeSelector(body.selector)) {
    res.status(400).json({ error: { code: "bad_selector", message: "invalid selector" } });
    return;
  }
  const selector = (body.selector as string).trim();

  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (message.length < 1 || message.length > MAX_MESSAGE) {
    res.status(400).json({
      error: {
        code: "bad_message",
        message: `message must be 1-${MAX_MESSAGE} chars`,
        chat: "Tell me what to change on this element in a few words.",
      },
    });
    return;
  }
  if (!hasIdempotencyKey(req)) {
    missingKey(res);
    return;
  }

  const tag = typeof body.tag === "string" ? body.tag.slice(0, 32) : "element";
  const style =
    body.style && typeof body.style === "object" ? (body.style as Record<string, string>) : {};
  const attrs =
    body.attrs && typeof body.attrs === "object"
      ? (body.attrs as Record<string, string>)
      : undefined;
  const segments = sanitizeSegments(body.segments) ?? undefined;
  const sentText = typeof body.text === "string" ? body.text : "";
  const text =
    sentText.trim().length === 0 && segments
      ? segments.join(" ").replace(/\s+/g, " ").trim()
      : sentText;
  if (isStructuralElementAsk(message)) {
    res.status(409).json({
      error: {
        code: NEEDS_SITE_CHANGE_CODE,
        chat: NEEDS_SITE_CHANGE_CHAT,
        request: elementScopedRequest({ selector, text, message, path: body.path }),
      },
    });
    return;
  }
  const tooMuchText = !!segments && segments.join("").length > MAX_RUN_CHARS;
  const styleOnly = tooMuchText && isStyleOnlyAsk(message);
  if (tooMuchText && !styleOnly) {
    res.status(422).json({ error: { code: "no_editable_change", chat: TOO_MUCH_TEXT } });
    return;
  }
  const sparse = body.sparse === true;
  const tenant_id = auth.tenant_id;

  await runMetered(res, tenant_id, app_id, async () => {
    const cleanMessage = await cleanInstruction(message, tenant_id);
    const companyContext = await buildCompanyFactSheet(tenant_id).catch(() => undefined);
    let raw: unknown;
    try {
      raw = await resolveInlineEdit(
        {
          tag,
          text,
          segments: styleOnly ? undefined : segments,
          style,
          attrs,
          message: cleanMessage,
          companyContext,
        },
        { tenantId: tenant_id, agentSlug: "website-inline-edit" },
      );
    } catch (e) {
      logInternal("resolve", tenant_id, e);
      return RESOLVE_FAILED;
    }

    const { patch, unchanged } = styleOnly
      ? fitStyleOnly(sanitizePatch(raw))
      : fitPatchToElement(sanitizePatch(raw), text, segments, sparse);
    if (patchIsEmpty(patch)) {
      return {
        status: 422,
        body: {
          error: {
            code: "no_editable_change",
            chat: unchanged
              ? "I couldn't find a better wording for this. Tell me the direction, like shorter, warmer, or more specific."
              : text.trim().length === 0 && !segments
                ? TOO_MUCH_TEXT
                : "I couldn't turn that into an edit on this element - try describing the text, color, or link.",
          },
        },
      };
    }

    const before = sanitizeBefore({ text, segments, style, attrs });
    const result = await upsertWebsiteEdit(tenant_id, app_id, selector, withBefore(patch, before), false);
    if (result.error || !result.version) {
      logInternal("write", tenant_id, result.error);
      return WRITE_FAILED;
    }
    return { status: 200, body: { patch, prior: result.prior ?? null, version: result.version } };
  });
}

export function fitStyleOnly(patch: StoredEditPatch): { patch: StoredEditPatch; unchanged: boolean } {
  const out: StoredEditPatch = { ...patch };
  delete out.text;
  delete out.segments;
  return { patch: out, unchanged: false };
}

function keepEdgeSpaces(original: string, rewritten: string): string {
  const lead = original.match(/^\s*/)?.[0] ?? "";
  const trail = original.match(/\s*$/)?.[0] ?? "";
  return lead + rewritten.trim() + trail;
}

export function fitPatchToElement(
  patch: StoredEditPatch,
  currentText: string,
  currentSegments: string[] | undefined,
  sparse = false,
): { patch: StoredEditPatch; unchanged: boolean } {
  const out: StoredEditPatch = { ...patch };
  let unchanged = false;
  if (currentSegments) {
    delete out.text;
    const model = out.segments;
    delete out.segments;
    if (
      model &&
      model.length === currentSegments.length &&
      model.every((s): s is string => typeof s === "string" && s.trim().length > 0)
    ) {
      const fitted = model.map((s, i) => keepEdgeSpaces(currentSegments[i], s));
      const same = fitted.map((s, i) => s.trim() === currentSegments[i].trim());
      if (same.every(Boolean)) unchanged = true;
      else out.segments = sparse ? fitted.map((s, i) => (same[i] ? null : s)) : fitted;
    }
  } else {
    delete out.segments;
    if (out.text !== undefined && out.text.trim() === currentText.trim()) {
      delete out.text;
      unchanged = true;
    }
  }
  return { patch: out, unchanged };
}

export async function resolveChatWebsiteEditHandler(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const body = (req.body ?? {}) as { app_id?: unknown; outline?: unknown; message?: unknown };
  const app_id = typeof body.app_id === "string" ? body.app_id : "";
  if (!app_id) {
    res.status(400).json({ error: { code: "missing_app", message: "app_id is required" } });
    return;
  }
  if (!(await allowSiteInlineWrite(auth, app_id, res))) return;

  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (message.length < 1 || message.length > MAX_MESSAGE) {
    res.status(400).json({
      error: {
        code: "bad_message",
        message: `message must be 1-${MAX_MESSAGE} chars`,
        chat: "Tell me what to change in a few words.",
      },
    });
    return;
  }

  const rawOutline = Array.isArray(body.outline) ? body.outline : [];
  const outline: OutlineEl[] = [];
  const allowed = new Set<string>();
  for (const e of rawOutline) {
    if (outline.length >= 150) break;
    if (!e || typeof e !== "object") continue;
    const o = e as { selector?: unknown; tag?: unknown; text?: unknown };
    if (!isSafeSelector(o.selector)) continue;
    const sel = (o.selector as string).trim();
    if (allowed.has(sel)) continue;
    allowed.add(sel);
    outline.push({
      selector: sel,
      tag: typeof o.tag === "string" ? o.tag.slice(0, 32) : "element",
      text: typeof o.text === "string" ? o.text.slice(0, 160) : "",
    });
  }
  if (outline.length === 0) {
    res.status(422).json({
      error: {
        code: "no_outline",
        chat: "I couldn't read your page's elements. Click the element you want to change instead.",
      },
    });
    return;
  }
  if (!hasIdempotencyKey(req)) {
    missingKey(res);
    return;
  }
  const tenant_id = auth.tenant_id;

  await runMetered(res, tenant_id, app_id, async () => {
    const cleanMessage = await cleanInstruction(message, tenant_id);
    const companyContext = await buildCompanyFactSheet(tenant_id).catch(() => undefined);

    let raw: unknown;
    try {
      raw = await resolveChatEditFromOutline(
        outline,
        cleanMessage,
        { companyContext },
        { tenantId: tenant_id, agentSlug: "website-chat-edit" },
      );
    } catch (e) {
      logInternal("resolve_chat", tenant_id, e);
      return RESOLVE_FAILED;
    }

    const obj = (raw && typeof raw === "object" ? raw : {}) as { selector?: unknown; patch?: unknown };
    const selector = typeof obj.selector === "string" ? obj.selector.trim() : "";
    if (!selector || !allowed.has(selector)) {
      return {
        status: 422,
        body: {
          error: {
            code: "no_target",
            chat: "I couldn't tell which part of the page you meant — try clicking it, or say which text to change.",
          },
        },
      };
    }
    const patch = sanitizePatch(obj.patch);
    delete patch.segments;
    if (patchIsEmpty(patch)) {
      return {
        status: 422,
        body: {
          error: {
            code: "no_editable_change",
            chat: "I couldn't turn that into a quick edit — it may need a full rebuild.",
          },
        },
      };
    }

    const picked = outline.find((e) => e.selector === selector);
    const before = sanitizeBefore({ text: picked?.text });
    const result = await upsertWebsiteEdit(tenant_id, app_id, selector, withBefore(patch, before), false);
    if (result.error || !result.version) {
      logInternal("write_chat", tenant_id, result.error);
      return WRITE_FAILED;
    }
    return { status: 200, body: { selector, patch, prior: result.prior ?? null, version: result.version } };
  });
}
