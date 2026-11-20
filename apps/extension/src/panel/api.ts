
import {
  AGENT_SLUG,
  ANSWER_POLL_MS,
  ANSWER_TIMEOUT_MS,
  API_BASE,
  RUN_STATUS_EVERY_N_POLLS,
} from "../shared/config";

export type ChatMessage = {
  id: string;
  sender_role: "user" | "assistant" | string;
  body: string;
  agent_run_id: string | null;
  created_at: string;
};

export type PageContextPayload =
  | {
      url: string;
      title: string;
      adapter_id: string;
      schema_version: number;
      extraction: unknown;
    }
  | { url: string; title: string };

export type ScreenshotPageContext = {
  mode: "screenshot";
  url: string;
  title: string;
};

export type SendResult = {
  thread_id: string;
  user_message_id: string;
  run_id: string | null;
};

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(message: string, status: number, code: string | null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const TERMINAL = new Set(["success", "parse_failed", "dispatch_error", "cancelled"]);

async function request<T>(
  path: string,
  token: string,
  init?: RequestInit,
): Promise<T> {
  let res: Response;
  try {
    const isForm = typeof FormData !== "undefined" && init?.body instanceof FormData;
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        ...(isForm ? {} : { "Content-Type": "application/json" }),
        Authorization: `Bearer ${token}`,
        ...(init?.headers ?? {}),
      },
    });
  } catch (e) {
    throw new ApiError(
      e instanceof Error ? e.message : "Network request failed.",
      0,
      "network",
    );
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
  }

  if (!res.ok) {
    const err = (body as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(
      err?.message ?? `Request failed (${res.status}).`,
      res.status,
      err?.code ?? null,
    );
  }
  return body as T;
}

export async function uploadScreenshot(
  token: string,
  blob: Blob,
): Promise<{ image_path: string }> {
  const form = new FormData();
  form.append("file", blob, "screenshot.jpg");
  return request<{ image_path: string }>(`/api/extension/screenshot`, token, {
    method: "POST",
    body: form,
  });
}

export async function sendChat(
  token: string,
  input: {
    message: string;
    threadId: string | null;
    screenshot?: { imagePath: string; pageContext: ScreenshotPageContext };
    panelSessionId?: string | null;
  },
): Promise<SendResult> {
  const body: Record<string, unknown> = {
    message: input.message,
    thread_id: input.threadId,
  };
  if (input.screenshot) {
    body.image_paths = [input.screenshot.imagePath];
    body.page_context = input.screenshot.pageContext;
  }
  if (input.panelSessionId) body.panel_session_id = input.panelSessionId;

  return request<SendResult>(`/api/agents/${AGENT_SLUG}/chat`, token, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function fetchHistory(
  token: string,
  threadId: string,
): Promise<{ messages: ChatMessage[] }> {
  const res = await request<{ messages: ChatMessage[] | null }>(
    `/api/agents/${AGENT_SLUG}/chat/history?thread_id=${encodeURIComponent(threadId)}`,
    token,
  );
  return { messages: res.messages ?? [] };
}

export async function fetchRunStatus(token: string, runId: string): Promise<string | null> {
  try {
    const res = await request<{ run?: { status?: string } }>(
      `/api/agents/runs/${encodeURIComponent(runId)}`,
      token,
    );
    return res.run?.status ?? null;
  } catch {
    return null;
  }
}

export type ProgressStep = {
  type: "step";
  key: string;
  label: string;
  state: "running" | "done" | "failed";
};

export type ProgressThought = {
  type: "thought";
  key: string;
  text: string;
  origin?: "plan";
};

export type ProgressTool = {
  key: string;
  name: string;
  input: string;
  output: string;
  ms: number;
  state: "running" | "done" | "failed";
};

export type ProgressGroup = {
  type: "group";
  key: string;
  label: string;
  count: number;
  state: "running" | "done" | "failed";
  tools: ProgressTool[];
};

export type ProgressItem = ProgressStep | ProgressThought | ProgressGroup;

const STEP_STATES = new Set(["running", "done", "failed"]);

const MAX_DETAIL = 400;

const MAX_LABEL = 80;

export async function fetchRunProgress(
  token: string,
  runId: string,
): Promise<ProgressItem[]> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), PROGRESS_TIMEOUT_MS);
  try {
    const res = await request<{ items?: unknown }>(
      `/api/agents/runs/${encodeURIComponent(runId)}/progress`,
      token,
      { signal: deadline.signal },
    );
    if (!Array.isArray(res.items)) return [];
    return res.items.filter(isRenderableStep);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

const PROGRESS_TIMEOUT_MS = 4000;

function printable(v: unknown, max: number, required = true): boolean {
  if (typeof v !== "string") return false;
  if (required && v.length === 0) return false;
  return v.length <= max;
}

function isRenderableTool(raw: unknown): raw is ProgressTool {
  if (!raw || typeof raw !== "object") return false;
  const t = raw as Record<string, unknown>;
  return (
    printable(t.key, MAX_LABEL) &&
    printable(t.name, MAX_LABEL) &&
    printable(t.input, MAX_DETAIL, false) &&
    printable(t.output, MAX_DETAIL, false) &&
    typeof t.ms === "number" &&
    Number.isFinite(t.ms) &&
    typeof t.state === "string" &&
    STEP_STATES.has(t.state)
  );
}

export function isRenderableStep(raw: unknown): raw is ProgressItem {
  if (!raw || typeof raw !== "object") return false;
  const s = raw as Record<string, unknown>;
  if (!printable(s.key, MAX_LABEL)) return false;

  if (s.type === "thought") return printable(s.text, MAX_DETAIL);

  if (!printable(s.label, MAX_LABEL)) return false;
  if (typeof s.state !== "string" || !STEP_STATES.has(s.state)) return false;
  if ((s.label as string).includes("__")) return false;
  if (s.type === "step") return true;
  if (s.type !== "group") return false;
  return (
    typeof s.count === "number" &&
    Array.isArray(s.tools) &&
    s.tools.length > 0 &&
    s.tools.length <= 50 &&
    s.tools.every(isRenderableTool)
  );
}

export type AwaitOutcome =
  | { kind: "answer"; messages: ChatMessage[] }
  | { kind: "no_reply"; status: string }
  | { kind: "timeout" };

export function findAnswerAfter(
  messages: ChatMessage[],
  userMessageId: string,
): boolean {
  const idx = messages.findIndex((m) => m.id === userMessageId);
  if (idx < 0) return false;
  return messages.slice(idx + 1).some((m) => m.sender_role === "assistant");
}

export async function awaitAnswer(
  token: string,
  args: {
    threadId: string;
    runId: string | null;
    userMessageId: string;
    signal?: AbortSignal;
    onTick?: (tick: number) => void;
  },
): Promise<AwaitOutcome> {
  const started = Date.now();
  let ticks = 0;
  let terminalStatus: string | null = null;
  let pollsSinceTerminal = 0;

  while (Date.now() - started < ANSWER_TIMEOUT_MS) {
    if (args.signal?.aborted) return { kind: "timeout" };
    await sleep(ANSWER_POLL_MS, args.signal);
    if (args.signal?.aborted) return { kind: "timeout" };
    ticks += 1;
    args.onTick?.(ticks);

    let messages: ChatMessage[] = [];
    try {
      messages = (await fetchHistory(token, args.threadId)).messages;
    } catch {
      continue;
    }

    if (findAnswerAfter(messages, args.userMessageId)) {
      return { kind: "answer", messages };
    }

    if (terminalStatus) {
      pollsSinceTerminal += 1;
      if (pollsSinceTerminal >= 2) return { kind: "no_reply", status: terminalStatus };
      continue;
    }

    if (args.runId && ticks % RUN_STATUS_EVERY_N_POLLS === 0) {
      const status = await fetchRunStatus(token, args.runId);
      if (status && TERMINAL.has(status)) terminalStatus = status;
    }
  }
  return { kind: "timeout" };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

export type Decision = {
  id: string;
  decision_class: string;
  body: unknown;
  status: string;
  agent_slug: string | null;
  thread_id: string | null;
};

export async function fetchApprovals(token: string): Promise<Decision[]> {
  const res = await request<{ decisions: Decision[] | null }>(`/api/approvals`, token);
  return res.decisions ?? [];
}

export const SHIP_RED_CODE = "requires_ship_red_override";

export async function approveDecision(
  token: string,
  id: string,
  opts?: { shipAnyway?: boolean; expectedFingerprint?: string },
): Promise<void> {
  const body: Record<string, unknown> = {};
  if (opts?.shipAnyway) body.ship_anyway = true;
  if (opts?.expectedFingerprint) body.expected_fingerprint = opts.expectedFingerprint;
  await request<unknown>(`/api/approvals/${encodeURIComponent(id)}/approve`, token, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function rejectDecision(token: string, id: string): Promise<void> {
  await request<unknown>(`/api/approvals/${encodeURIComponent(id)}/reject`, token, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export type ClaimedOp = {
  id: string;
  run_id: string;
  seq: number;
  tab_id: number;
  op: unknown;
  is_write: boolean;
  execution_token: string;
  lease_until: string;
};

export async function createPanelSession(
  token: string,
  tabId: number,
): Promise<{ session_id: string }> {
  return request<{ session_id: string }>(`/api/extension/sessions`, token, {
    method: "POST",
    body: JSON.stringify({ tab_id: tabId }),
  });
}

export async function heartbeatPanelSession(token: string, sessionId: string): Promise<void> {
  await request<unknown>(
    `/api/extension/sessions/${encodeURIComponent(sessionId)}/heartbeat`,
    token,
    { method: "POST", body: JSON.stringify({}) },
  );
}

export async function endPanelSession(token: string, sessionId: string): Promise<void> {
  await request<unknown>(`/api/extension/sessions/${encodeURIComponent(sessionId)}`, token, {
    method: "DELETE",
    keepalive: true,
  });
}

export async function nextPanelOp(
  token: string,
  sessionId: string,
  signal?: AbortSignal,
): Promise<ClaimedOp | null> {
  const res = await request<{ op: ClaimedOp } | undefined>(
    `/api/extension/ops/next?session=${encodeURIComponent(sessionId)}`,
    token,
    { signal },
  );
  return res?.op ?? null;
}

export async function postPanelOpResult(
  token: string,
  opId: string,
  body: {
    session_id: string;
    run_id: string;
    execution_token: string;
    status: "done" | "failed";
    result: Record<string, unknown>;
  },
): Promise<void> {
  await request<unknown>(`/api/extension/ops/${encodeURIComponent(opId)}/result`, token, {
    method: "POST",
    body: JSON.stringify(body),
  });
}
