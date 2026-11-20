
import {
  ApiError,
  createPanelSession,
  endPanelSession,
  heartbeatPanelSession,
  nextPanelOp,
  postPanelOpResult,
  type ClaimedOp,
} from "../api";
import { OwnTabCdp, realDebuggerApi, type DebuggerApi, type DebuggerTarget } from "./cdp";
import { executeOp, parseOp, type OpOutcome, type SnapshotNode } from "./ops";
import { stepLine } from "./copy";

export const EXEC_TOKENS_KEY = "zv_exec_tokens";
const MAX_REMEMBERED_TOKENS = 500;
export const HEARTBEAT_MS = 10_000;
export const IDLE_DETACH_MS = 30_000;
const RETRY_MS = 15_000;

export type SessionArea = {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
};

export class TokenLedger {
  constructor(private readonly area: SessionArea) {}

  private async list(): Promise<string[]> {
    const got = await this.area.get(EXEC_TOKENS_KEY);
    const v = got[EXEC_TOKENS_KEY];
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : [];
  }

  async has(token: string): Promise<boolean> {
    return (await this.list()).includes(token);
  }

  async add(token: string): Promise<void> {
    const next = [...(await this.list()), token].slice(-MAX_REMEMBERED_TOKENS);
    await this.area.set({ [EXEC_TOKENS_KEY]: next });
  }
}

export type GuardResult =
  | { run: false; post: false }
  | { run: false; post: true; outcome: OpOutcome }
  | { run: true };

export async function guardClaimedOp(
  claimed: ClaimedOp,
  ownTabId: number,
  tokens: TokenLedger,
): Promise<GuardResult> {
  if (claimed.tab_id !== ownTabId) {
    return {
      run: false,
      post: true,
      outcome: {
        status: "failed",
        result: { error_code: "wrong_tab", error_message: "This panel only works in its own tab.", top_url: null },
      },
    };
  }
  if (typeof claimed.execution_token !== "string" || (await tokens.has(claimed.execution_token))) {
    return { run: false, post: false };
  }
  await tokens.add(claimed.execution_token);
  return { run: true };
}

export type ControlState = {
  working: boolean;
  lines: string[];
  stopped: boolean;
};

export type ControlDeps = {
  tabId: number;
  getToken: () => Promise<string | null>;
  onChange: (s: ControlState) => void;
  debuggerApi?: DebuggerApi;
  sessionArea?: SessionArea;
  topUrl?: () => Promise<string | null>;
  tabTitle?: () => Promise<string | null>;
};

async function defaultTab(tabId: number): Promise<chrome.tabs.Tab | null> {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
}

export class BrowserControl {
  private readonly deps: ControlDeps;
  private readonly cdp: OwnTabCdp;
  private readonly tokens: TokenLedger;
  private readonly debuggerApi: DebuggerApi;
  private sessionId: string | null = null;
  private running = false;
  private poll: AbortController | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private idle: ReturnType<typeof setTimeout> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private state: ControlState = { working: false, lines: [], stopped: false };
  private names = new Map<string, string>();
  private lastToken: string | null = null;

  private readonly onDetach = (source: DebuggerTarget, reason: string) => {
    if (source.tabId !== this.deps.tabId || source.sessionId) return;
    this.cdp.markDetached();
    void this.endTask(reason === "canceled_by_user");
  };

  static available(): boolean {
    return typeof chrome !== "undefined" && !!(chrome as { debugger?: unknown }).debugger;
  }

  constructor(deps: ControlDeps) {
    this.deps = deps;
    this.debuggerApi = deps.debuggerApi ?? realDebuggerApi();
    this.cdp = new OwnTabCdp(deps.tabId, this.debuggerApi);
    this.tokens = new TokenLedger(deps.sessionArea ?? (chrome.storage.session as unknown as SessionArea));
  }

  get currentSessionId(): string | null {
    return this.sessionId;
  }

  private emit(patch: Partial<ControlState>): void {
    this.state = { ...this.state, ...patch };
    this.deps.onChange(this.state);
  }

  private async token(): Promise<string | null> {
    const t = await this.deps.getToken();
    this.lastToken = t;
    return t;
  }

  private topUrl(): Promise<string | null> {
    if (this.deps.topUrl) return this.deps.topUrl();
    return defaultTab(this.deps.tabId).then((t) => t?.pendingUrl || t?.url || null);
  }

  private tabTitle(): Promise<string | null> {
    if (this.deps.tabTitle) return this.deps.tabTitle();
    return defaultTab(this.deps.tabId).then((t) => t?.title ?? null);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.debuggerApi.onDetach.addListener(this.onDetach);
    await this.openSession();
  }

  private async openSession(): Promise<void> {
    if (!this.running) return;
    const token = await this.token();
    if (!token) return this.shutdown();
    try {
      this.sessionId = (await createPanelSession(token, this.deps.tabId)).session_id;
    } catch (e) {
      if (e instanceof ApiError && [401, 403, 404].includes(e.status)) return this.shutdown();
      this.retry = setTimeout(() => void this.openSession(), RETRY_MS);
      return;
    }
    this.heartbeat = setInterval(() => void this.beat(), HEARTBEAT_MS);
    void this.pollLoop(this.sessionId);
  }

  private async beat(): Promise<void> {
    const id = this.sessionId;
    const token = await this.token();
    if (!id || !token) return;
    try {
      await heartbeatPanelSession(token, id);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) void this.renewSession();
    }
  }

  private async renewSession(): Promise<void> {
    this.clearSessionTimers();
    this.sessionId = null;
    await this.detachDebugger();
    this.emit({ working: false });
    await this.openSession();
  }

  private clearSessionTimers(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.poll?.abort();
    this.poll = null;
  }

  private async pollLoop(session: string): Promise<void> {
    while (this.running && this.sessionId === session) {
      const token = await this.token();
      if (!token) return this.shutdown();
      const ac = new AbortController();
      this.poll = ac;
      let claimed: ClaimedOp | null;
      try {
        claimed = await nextPanelOp(token, session, ac.signal);
      } catch (e) {
        if (ac.signal.aborted || this.sessionId !== session) return;
        if (e instanceof ApiError && e.status === 404) return void this.renewSession();
        if (e instanceof ApiError && (e.status === 401 || e.status === 403)) return this.shutdown();
        await new Promise((r) => setTimeout(r, RETRY_MS));
        continue;
      }
      if (claimed) await this.handle(token, session, claimed);
    }
  }

  private async handle(token: string, session: string, claimed: ClaimedOp): Promise<void> {
    const guard = await guardClaimedOp(claimed, this.deps.tabId, this.tokens);
    let outcome: OpOutcome;
    if (!guard.run) {
      if (!guard.post) return;
      outcome = guard.outcome;
    } else {
      if (this.idle) clearTimeout(this.idle);
      try {
        await this.cdp.attach();
      } catch {
        await this.detachDebugger();
        outcome = {
          status: "failed",
          result: { error_code: "attach_failed", error_message: "Zavi could not attach to this tab.", top_url: await this.topUrl() },
        };
        await this.post(token, session, claimed, outcome);
        return;
      }
      if (!this.running || this.sessionId !== session) {
        await this.detachDebugger();
        outcome = {
          status: "failed",
          result: { error_code: "stopped", error_message: "Stopped before this step ran.", top_url: await this.topUrl() },
        };
        await this.post(token, session, claimed, outcome);
        return;
      }
      if (!this.state.working) this.emit({ working: true, lines: [], stopped: false });
      outcome = await executeOp(this.cdp, claimed.op, () => this.topUrl(), { settle: true });
      await this.noteStep(claimed.op, outcome);
      this.idle = setTimeout(() => void this.runFinished(), IDLE_DETACH_MS);
    }
    await this.post(token, session, claimed, outcome);
  }

  private async post(token: string, session: string, claimed: ClaimedOp, outcome: OpOutcome): Promise<void> {
    try {
      await postPanelOpResult(token, claimed.id, {
        session_id: session,
        run_id: claimed.run_id,
        execution_token: claimed.execution_token,
        status: outcome.status,
        result: outcome.result,
      });
    } catch {
    }
  }

  private async noteStep(raw: unknown, outcome: OpOutcome): Promise<void> {
    const op = parseOp(raw);
    if (!op) return;
    if (op.op === "ax_snapshot" && outcome.status === "done") {
      this.names.clear();
      for (const n of (outcome.result.nodes as SnapshotNode[] | undefined) ?? []) {
        this.names.set(`${n.ref.frame_session ?? ""}:${n.ref.backend_node_id}`, n.name);
      }
      return;
    }
    if (outcome.status !== "done") return;
    if ((op.op === "set_checked" || op.op === "select_option") && outcome.result.changed === false) return;
    const ref = op.op === "click_ref" || op.op === "type_ref" || op.op === "select_option" || op.op === "set_checked" ? op.ref : null;
    const line = stepLine(op, {
      targetName: ref ? this.names.get(`${ref.frame_session ?? ""}:${ref.backend_node_id}`) : null,
      pageTitle: op.op === "nav" ? await this.tabTitle() : null,
    });
    if (line) this.emit({ lines: [...this.state.lines, line] });
  }

  private async detachDebugger(): Promise<void> {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    await this.cdp.detach();
  }

  async runFinished(): Promise<void> {
    await this.detachDebugger();
    if (this.state.working) this.emit({ working: false });
  }

  private async endTask(byPerson: boolean): Promise<void> {
    const id = this.sessionId;
    this.clearSessionTimers();
    this.sessionId = null;
    await this.detachDebugger();
    this.emit({ working: false, stopped: byPerson });
    const token = await this.token();
    if (id && token) await endPanelSession(token, id).catch(() => undefined);
    await this.openSession();
  }

  stopTask(): Promise<void> {
    return this.endTask(true);
  }

  async stop(): Promise<void> {
    const id = this.sessionId;
    const held = this.lastToken;
    this.sessionId = null;
    this.running = false;
    this.shutdown();
    const ended = id && held ? endPanelSession(held, id).catch(() => undefined) : null;
    const detached = this.detachDebugger();
    if (id && !held) {
      const token = await this.deps.getToken().catch(() => null);
      if (token) await endPanelSession(token, id).catch(() => undefined);
    }
    await Promise.all([ended, detached]);
  }

  private shutdown(): void {
    this.running = false;
    this.clearSessionTimers();
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.debuggerApi.onDetach.removeListener(this.onDetach);
  }
}
