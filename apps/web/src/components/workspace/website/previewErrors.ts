export const PREVIEW_ERRORS_READY = "zavi:preview-errors-ready";
export const PREVIEW_ERRORS_HELLO = "zavi:preview-errors-hello";
export const PREVIEW_ERRORS_SYNC = "zavi:preview-errors";

export const PREVIEW_ERRORS_MAX = 20;
export const FIX_MESSAGE_MAX = 4000;
const MESSAGE_MAX = 500;
const STACK_MAX = 2000;
const PAGE_MAX = 200;

export type PreviewErrorKind = "error" | "rejection" | "console" | "compile" | "load";

export type PreviewError = {
  kind: PreviewErrorKind;
  message: string;
  stack: string;
  page: string;
  count: number;
};

const KINDS = new Set<PreviewErrorKind>(["error", "rejection", "console", "compile", "load"]);

const REACT_DEV_WARNINGS = [
  /^(?:[A-Za-z]*Error:\s*)?Warning:/,
  /Each child in a list should have a unique/i,
  /validateDOMNesting/,
  /cannot appear as a (?:child|descendant) of/i,
  /Cannot update a component .* while rendering a different component/i,
  /is changing an? (?:un)?controlled input/i,
  /React does not recognize the .* prop/i,
  /Invalid DOM property/i,
  /Received `(?:true|false)` for a non-boolean attribute/i,
  /findDOMNode is deprecated/i,
  /Support for defaultProps will be removed/i,
  /componentWill(?:Mount|ReceiveProps|Update) has been renamed/i,
  /Can't perform a React state update on an unmounted component/i,
  /ReactDOM\.render is no longer supported/i,
];

export function isReactDevWarning(message: string): boolean {
  return REACT_DEV_WARNINGS.some((pattern) => pattern.test(message));
}

function isNoise(message: string, stack: string): boolean {
  if (/^(?:Uncaught\s+)?Script error\.?$/i.test(message.trim())) return true;
  if (/zavi-editor-runtime|zavi-picker|__zaviErrorCatcher/.test(`${message}\n${stack}`)) return true;
  return isReactDevWarning(message);
}

export function scrubSecrets(text: string): string {
  return String(text ?? "")
    .replace(/(https?:\/\/[^\s?#"'()<>]+)\?[^\s#"'()<>]*?((?::\d+){0,2})(?=[\s#"'()<>]|$)/g, "$1$2")
    .replace(/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g, "[redacted]")
    .replace(/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/g, "[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(
      /((?:api[_-]?key|apikey|token|secret|password|passwd|authorization|access[_-]?key|client[_-]?secret|signature)["']?\s*[:=]\s*["']?)[^\s"',;&)]+/gi,
      "$1[redacted]",
    )
    .replace(/[A-Za-z0-9_-]{40,}/g, "[redacted]");
}

function clip(text: string, max: number): string {
  const clean = scrubSecrets(text);
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function cleanPage(raw: unknown): string {
  if (typeof raw !== "string") return "/";
  const path = raw.split(/[?#]/)[0] ?? "";
  return path.startsWith("/") ? clip(path, PAGE_MAX) : "/";
}

export function parsePreviewErrorsMessage(data: unknown): PreviewError[] | null {
  if (!data || typeof data !== "object") return null;
  const record = data as { type?: unknown; errors?: unknown };
  if (record.type !== PREVIEW_ERRORS_SYNC || !Array.isArray(record.errors)) return null;
  const out: PreviewError[] = [];
  const seen = new Set<string>();
  for (const raw of record.errors.slice(-PREVIEW_ERRORS_MAX)) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    if (typeof item.message !== "string" || !KINDS.has(item.kind as PreviewErrorKind)) continue;
    const message = clip(item.message.trim(), MESSAGE_MAX);
    const stack = typeof item.stack === "string" ? clip(item.stack, STACK_MAX) : "";
    if (!message || isNoise(message, stack)) continue;
    const key = errorKey({ message });
    if (seen.has(key)) continue;
    seen.add(key);
    const count = typeof item.count === "number" && Number.isFinite(item.count) ? Math.max(1, Math.min(9999, Math.floor(item.count))) : 1;
    out.push({ kind: item.kind as PreviewErrorKind, message, stack, page: cleanPage(item.page), count });
  }
  return out;
}

export function errorKey(error: Pick<PreviewError, "message">): string {
  return error.message;
}

export function pillLabel(count: number): string {
  return `Something broke in your preview (${count})`;
}

function traceLines(error: PreviewError, lines: number): string[] {
  return error.stack
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && line !== error.message)
    .slice(0, lines);
}

export function errorDetails(error: PreviewError): string {
  return scrubSecrets([`On ${error.page}: ${error.message}`, ...traceLines(error, 40)].join("\n"));
}

export function buildFixMessage(errors: readonly PreviewError[]): string {
  const header =
    errors.length === 1 ? "Fix this error in the preview:" : `Fix these ${errors.length} errors in the preview:`;
  const blocks = errors.map((error, index) => {
    const prefix = errors.length === 1 ? "" : `${index + 1}. `;
    const trace = traceLines(error, 4).map((line) => `   ${line}`);
    return [`${prefix}On ${error.page}: ${error.message}`, ...trace].join("\n");
  });
  let text = header;
  for (const block of blocks) {
    const next = `${text}\n\n${block}`;
    if (scrubSecrets(next).length > FIX_MESSAGE_MAX) break;
    text = next;
  }
  if (text === header && blocks[0]) text = `${header}\n\n${blocks[0]}`;
  const clean = scrubSecrets(text);
  return clean.length > FIX_MESSAGE_MAX ? `${clean.slice(0, FIX_MESSAGE_MAX - 1)}…` : clean;
}
