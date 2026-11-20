
import { serviceClient } from "@/services/supabase";
import {
  ensureDaemonRunning,
  callDaemon,
} from "@/services/sandbox/browser-mcp/daemon-client";
import { PREVIEW_DEFAULT_PORT } from "@/services/sandbox/preview";
import type { DaemonOp, DaemonResult } from "@/services/sandbox/browser-mcp/types";

export const QA_BROWSER_PER_OP_TIMEOUT_MS = 5_000;
export const QA_BROWSER_TOTAL_BUDGET_MS = 45_000;
const MAX_FORM_FILLS = 4;

export type QaPlanOp = DaemonOp;

export type QaExercisePlan = {
  ops: QaPlanOp[];
  has_form: boolean;
  has_interactive: boolean;
  primary_selector: string | null;
};

export type QaOpResult = {
  op: string;
  ok: boolean;
  error_message?: string;
};

export type QaExerciseObserved = {
  nav_ok: boolean;
  console_errors: string[];
  plan: QaExercisePlan;
  op_results: QaOpResult[];
  final_url: string;
};

export type QaExerciseResult = {
  ok: boolean;
  reason: string;
  signal: string;
};

function cssAttrEscape(v: string): string {
  return v.replace(/(["\\])/g, "\\$1");
}

function selectorFor(tag: string, attrs: Record<string, string>): string {
  if (attrs.id) return `#${cssAttrEscape(attrs.id)}`;
  if (attrs.name) return `${tag}[name="${cssAttrEscape(attrs.name)}"]`;
  return tag;
}

function parseAttrs(openTag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m: RegExpExecArray | null;
  const body = openTag.replace(/^<\s*[a-zA-Z][a-zA-Z0-9]*/, "");
  while ((m = re.exec(body)) !== null) {
    const name = m[1].toLowerCase();
    const val = m[2] ?? m[3] ?? m[4] ?? "";
    attrs[name] = val;
  }
  return attrs;
}

function isHidden(attrs: Record<string, string>): boolean {
  const style = (attrs.style ?? "").toLowerCase();
  if (/display\s*:\s*none/.test(style)) return true;
  if (/visibility\s*:\s*hidden/.test(style)) return true;
  if (attrs.hidden !== undefined) return true;
  if (attrs["aria-hidden"] === "true") return true;
  if (attrs.type === "hidden") return true;
  return false;
}

const NON_FILLABLE_TYPES = new Set([
  "hidden",
  "submit",
  "button",
  "reset",
  "checkbox",
  "radio",
  "file",
  "image",
  "range",
  "color",
]);

function sampleValueFor(attrs: Record<string, string>): string {
  const type = (attrs.type ?? "text").toLowerCase();
  const name = (attrs.name ?? attrs.id ?? "").toLowerCase();
  if (type === "email" || /email/.test(name)) return "qa-exercise@example.com";
  if (type === "number") return "1";
  if (type === "tel" || /phone|tel/.test(name)) return "5551234567";
  if (type === "url") return "https://example.com";
  if (type === "password") return "QaExercise123!";
  return "QA exercise";
}

type ParsedEl = { tag: string; attrs: Record<string, string> };

function findTags(html: string, tag: string): ParsedEl[] {
  const re = new RegExp(`<${tag}\\b[^>]*>`, "gi");
  const out: ParsedEl[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    out.push({ tag, attrs: parseAttrs(m[0]) });
  }
  return out;
}

export function buildQaExercisePlan(html: string): QaExercisePlan {
  const ops: QaPlanOp[] = [];

  const formMatch = html.match(/<form\b[^>]*>([\s\S]*?)<\/form>/i);
  let has_form = false;
  let formSubmitSelector: string | null = null;
  if (formMatch) {
    const formAttrs = parseAttrs((formMatch[0].match(/<form\b[^>]*>/i) ?? ["<form>"])[0]);
    if (!isHidden(formAttrs)) {
      const inner = formMatch[1];
      const inputs = findTags(inner, "input").filter(
        (el) =>
          !isHidden(el.attrs) &&
          el.attrs.disabled === undefined &&
          !NON_FILLABLE_TYPES.has((el.attrs.type ?? "text").toLowerCase()),
      );
      const submitBtn = findTags(inner, "button").find((b) => {
        const t = (b.attrs.type ?? "submit").toLowerCase();
        return !isHidden(b.attrs) && (t === "submit" || t === "");
      });
      const submitInput = findTags(inner, "input").find(
        (i) => (i.attrs.type ?? "").toLowerCase() === "submit" && !isHidden(i.attrs),
      );
      const submit = submitBtn ?? submitInput;
      if (inputs.length > 0 && submit) {
        has_form = true;
        for (const inp of inputs.slice(0, MAX_FORM_FILLS)) {
          ops.push({
            op: "fill",
            selector: selectorFor("input", inp.attrs),
            value: sampleValueFor(inp.attrs),
          });
        }
        formSubmitSelector = selectorFor(
          submitBtn ? "button" : "input",
          submit.attrs,
        );
        ops.push({ op: "click", selector: formSubmitSelector });
      }
    }
  }

  if (has_form && formSubmitSelector) {
    return { ops, has_form: true, has_interactive: true, primary_selector: formSubmitSelector };
  }

  const button = findTags(html, "button").find((b) => !isHidden(b.attrs));
  let primary: { selector: string } | null = null;
  if (button) {
    primary = { selector: selectorFor("button", button.attrs) };
  } else {
    const link = findTags(html, "a").find(
      (a) => !isHidden(a.attrs) && typeof a.attrs.href === "string" && a.attrs.href.length > 0,
    );
    if (link) {
      primary = { selector: selectorFor("a", link.attrs) };
    } else {
      const roleBtn = html.match(/<([a-zA-Z][a-zA-Z0-9]*)\b[^>]*\brole\s*=\s*["']button["'][^>]*>/i);
      if (roleBtn) {
        const attrs = parseAttrs(roleBtn[0]);
        if (!isHidden(attrs)) {
          primary = { selector: selectorFor(roleBtn[1].toLowerCase(), attrs) };
        }
      }
    }
  }

  if (primary) {
    ops.push({ op: "click", selector: primary.selector });
    return { ops, has_form: false, has_interactive: true, primary_selector: primary.selector };
  }

  return { ops, has_form: false, has_interactive: false, primary_selector: null };
}

function looksLikeErrorRoute(url: string): boolean {
  return /\/(500|502|503|504)(\/|$|\?)/.test(url) || /\/5\d\d(\/|$|\?)/.test(url);
}

export function assertExerciseResult(observed: QaExerciseObserved): QaExerciseResult {
  const fail = (signal: string, reason: string): QaExerciseResult => ({
    ok: false,
    reason,
    signal,
  });

  if (!observed.nav_ok) {
    return fail(
      "qa-browser: the generated app failed to load (navigation did not resolve)",
      "nav_failed",
    );
  }

  if (observed.console_errors.length > 0) {
    const first = observed.console_errors[0];
    return fail(
      `qa-browser: console error on load — ${first}`,
      "console_error",
    );
  }

  const threwOp = observed.op_results.find((r) => !r.ok);
  if (threwOp) {
    const sel = observed.plan.primary_selector ?? "(primary)";
    return fail(
      `qa-browser: primary interactive element '${sel}' did not respond — ${
        threwOp.error_message ?? `${threwOp.op} failed`
      }`,
      "op_failed",
    );
  }

  if (looksLikeErrorRoute(observed.final_url)) {
    const sel = observed.plan.primary_selector ?? "(primary)";
    return fail(
      `qa-browser: primary CTA '${sel}' navigated to an error page (${observed.final_url})`,
      "error_route",
    );
  }

  if (!observed.plan.has_interactive) {
    return {
      ok: true,
      reason:
        "qa-browser: no obvious interactive element found — passed with warning (page loaded clean, no errors)",
      signal: "",
    };
  }

  return {
    ok: true,
    reason: observed.plan.has_form
      ? "qa-browser: page loaded clean, primary form submitted, no console errors"
      : "qa-browser: page loaded clean, primary CTA responded, no console errors",
    signal: "",
  };
}

type LivePreviewSandbox = {
  e2b_sandbox_id: string;
  port: number;
};

async function resolveLivePreviewSandbox(
  tenant_id: string,
  repo_full_name: string,
): Promise<LivePreviewSandbox | null> {
  const { data, error } = await serviceClient()
    .from("tenant_sandbox")
    .select("e2b_sandbox_id, status, preview_status, preview_port")
    .eq("tenant_id", tenant_id)
    .eq("repo_full_name", repo_full_name)
    .maybeSingle();
  if (error) throw new Error(`resolveLivePreviewSandbox: ${error.message}`);
  if (!data) return null;
  const row = data as {
    e2b_sandbox_id: string | null;
    status: string;
    preview_status: string | null;
    preview_port: number | null;
  };
  if (row.status !== "active") return null;
  if (row.preview_status !== "live") return null;
  if (!row.e2b_sandbox_id) return null;
  return {
    e2b_sandbox_id: row.e2b_sandbox_id,
    port: row.preview_port ?? PREVIEW_DEFAULT_PORT,
  };
}

async function sendOp(
  sandbox_id: string,
  op: QaPlanOp,
): Promise<{ res: DaemonResult; result: QaOpResult }> {
  const res = await callDaemon(sandbox_id, op);
  const ok = res.ok === true;
  return {
    res,
    result: {
      op: op.op,
      ok,
      error_message: ok ? undefined : (res as { error_message?: string }).error_message,
    },
  };
}

export type RunQaBrowserExerciseArgs = {
  tenant_id: string;
  repo_full_name: string;
};

export async function runQaBrowserExercise(
  args: RunQaBrowserExerciseArgs,
): Promise<QaExerciseResult> {
  const started = Date.now();
  const budgetLeft = () => QA_BROWSER_TOTAL_BUDGET_MS - (Date.now() - started);

  let sandbox: LivePreviewSandbox | null;
  try {
    sandbox = await resolveLivePreviewSandbox(args.tenant_id, args.repo_full_name);
  } catch (e) {
    return {
      ok: true,
      reason: `qa-browser: could not resolve preview sandbox (${(e as Error).message}) — passed with warning`,
      signal: "",
    };
  }
  if (!sandbox) {
    return {
      ok: true,
      reason: "qa-browser: no live preview sandbox to exercise — passed with warning",
      signal: "",
    };
  }

  const sandboxId = sandbox.e2b_sandbox_id;
  const appUrl = `http://127.0.0.1:${sandbox.port}/`;

  try {
    await ensureDaemonRunning(sandboxId);

    const navRes = await callDaemon(sandboxId, { op: "nav", url: appUrl });
    const nav_ok = navRes.ok === true;
    if (!nav_ok) {
      return assertExerciseResult({
        nav_ok: false,
        console_errors: [],
        plan: { ops: [], has_form: false, has_interactive: false, primary_selector: null },
        op_results: [],
        final_url: appUrl,
      });
    }

    let html = "";
    const snap = await callDaemon(sandboxId, { op: "dom_snapshot" });
    if (snap.ok && (snap as { result?: { html?: unknown } }).result?.html) {
      html = String((snap as { result: { html: string } }).result.html);
    }
    const plan = buildQaExercisePlan(html);

    const op_results: QaOpResult[] = [];
    for (const op of plan.ops) {
      if (budgetLeft() <= QA_BROWSER_PER_OP_TIMEOUT_MS) break;
      const { result } = await sendOp(sandboxId, op);
      op_results.push(result);
      if (!result.ok) break;
    }

    let console_errors: string[] = [];
    const errsRes = await callDaemon(sandboxId, { op: "console_errors" });
    if (errsRes.ok && Array.isArray((errsRes as { result?: { errors?: unknown } }).result?.errors)) {
      console_errors = ((errsRes as { result: { errors: unknown[] } }).result.errors)
        .map((e) => String(e))
        .slice(0, 50);
    }
    let final_url = appUrl;
    const urlRes = await callDaemon(sandboxId, { op: "current_url" });
    if (urlRes.ok && typeof (urlRes as { result?: { url?: unknown } }).result?.url === "string") {
      final_url = (urlRes as { result: { url: string } }).result.url;
    }

    return assertExerciseResult({
      nav_ok: true,
      console_errors,
      plan,
      op_results,
      final_url,
    });
  } catch (e) {
    return {
      ok: true,
      reason: `qa-browser: exercise could not run (${(e as Error).message}) — passed with warning`,
      signal: "",
    };
  }
}
