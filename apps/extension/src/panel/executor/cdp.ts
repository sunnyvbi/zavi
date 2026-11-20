
export const CDP_PROTOCOL_VERSION = "1.3";

export const ALLOWED_CDP_METHODS: ReadonlySet<string> = new Set([
  "Accessibility.enable",
  "Accessibility.getFullAXTree",
  "Accessibility.getPartialAXTree",
  "DOM.getDocument",
  "DOM.enable",
  "DOM.getBoxModel",
  "DOM.getNodeForLocation",
  "DOM.scrollIntoViewIfNeeded",
  "DOM.focus",
  "Input.dispatchMouseEvent",
  "Input.dispatchKeyEvent",
  "Input.insertText",
  "Input.setInterceptDrags",
  "Input.dispatchDragEvent",
  "Page.enable",
  "Page.navigate",
  "Page.captureScreenshot",
  "Page.getLayoutMetrics",
  "Page.handleJavaScriptDialog",
  "Page.getNavigationHistory",
  "Page.navigateToHistoryEntry",
  "Page.reload",
  "Page.setLifecycleEventsEnabled",
  "Page.getFrameTree",
  "DOMSnapshot.captureSnapshot",
  "Target.setAutoAttach",
]);

export class CdpNotAllowedError extends Error {
  constructor(method: string) {
    super(`CDP method not allowed: ${method}`);
    this.name = "CdpNotAllowedError";
  }
}

export class UnknownFrameError extends Error {
  constructor() {
    super("That frame is not part of this tab.");
    this.name = "UnknownFrameError";
  }
}

export type DialogSeen = { type: string; message: string };

const MAX_DIALOG_MESSAGE = 300;
const MAX_DIALOGS_KEPT = 10;

export type DebuggerTarget = { tabId: number; sessionId?: string };

type Listener<A extends unknown[]> = {
  addListener(fn: (...a: A) => void): void;
  removeListener(fn: (...a: A) => void): void;
};

export type DebuggerApi = {
  attach(target: DebuggerTarget, version: string): Promise<void>;
  detach(target: DebuggerTarget): Promise<void>;
  sendCommand(target: DebuggerTarget, method: string, params?: object): Promise<unknown>;
  onEvent: Listener<[DebuggerTarget, string, unknown]>;
  onDetach: Listener<[DebuggerTarget, string]>;
};

export function realDebuggerApi(): DebuggerApi {
  return chrome.debugger as unknown as DebuggerApi;
}

const AUTO_ATTACH = { autoAttach: true, waitForDebuggerOnStart: false, flatten: true };

export class OwnTabCdp {
  readonly tabId: number;
  private readonly api: DebuggerApi;
  private attached = false;
  private readonly frames = new Set<string>();
  private loadWaiters: (() => void)[] = [];
  private dialogs: DialogSeen[] = [];
  private promptText = "";
  private mainFrameId: string | null = null;
  private networkIdle: boolean | null = null;
  private dragData: unknown = null;
  private readonly onEvent = (source: DebuggerTarget, method: string, params: unknown) => {
    if (source.tabId !== this.tabId) return;
    const p = (params ?? {}) as {
      sessionId?: unknown;
      targetInfo?: { type?: unknown };
      type?: unknown;
      message?: unknown;
      frameId?: unknown;
      name?: unknown;
      frame?: { id?: unknown; parentId?: unknown };
      data?: unknown;
    };
    if (method === "Target.attachedToTarget" && typeof p.sessionId === "string") {
      this.frames.add(p.sessionId);
      void this.send("Target.setAutoAttach", AUTO_ATTACH, p.sessionId).catch(() => undefined);
      void this.send("Page.enable", {}, p.sessionId).catch(() => undefined);
    } else if (method === "Target.detachedFromTarget" && typeof p.sessionId === "string") {
      this.frames.delete(p.sessionId);
    } else if (method === "Page.javascriptDialogOpening") {
      const type = typeof p.type === "string" ? p.type : "alert";
      this.dialogs.push({ type, message: typeof p.message === "string" ? p.message.slice(0, MAX_DIALOG_MESSAGE) : "" });
      if (this.dialogs.length > MAX_DIALOGS_KEPT) this.dialogs.shift();
      const answer = type === "prompt" ? { accept: true, promptText: this.promptText } : { accept: true };
      void this.send("Page.handleJavaScriptDialog", answer, source.sessionId ?? null).catch(() => undefined);
    } else if (method === "Input.dragIntercepted") {
      this.dragData = p.data ?? null;
    } else if (!source.sessionId && method === "Page.frameNavigated" && p.frame && !p.frame.parentId) {
      if (typeof p.frame.id === "string") this.mainFrameId = p.frame.id;
    } else if (!source.sessionId && method === "Page.lifecycleEvent") {
      if (this.mainFrameId && p.frameId !== this.mainFrameId) return;
      if (p.name === "init") this.networkIdle = false;
      else if (p.name === "networkAlmostIdle" || p.name === "networkIdle") this.networkIdle = true;
    } else if (!source.sessionId && (method === "Page.loadEventFired" || method === "Page.navigatedWithinDocument")) {
      const waiters = this.loadWaiters;
      this.loadWaiters = [];
      for (const w of waiters) w();
    }
  };

  constructor(tabId: number, api: DebuggerApi = realDebuggerApi()) {
    this.tabId = tabId;
    this.api = api;
  }

  isAttached(): boolean {
    return this.attached;
  }

  hasFrame(session: string): boolean {
    return this.frames.has(session);
  }

  async attach(): Promise<void> {
    if (this.attached) return;
    await this.api.attach({ tabId: this.tabId }, CDP_PROTOCOL_VERSION);
    this.attached = true;
    this.api.onEvent.addListener(this.onEvent);
    await this.send("Page.enable");
    await this.send("Target.setAutoAttach", AUTO_ATTACH);
    try {
      const tree = (await this.send("Page.getFrameTree")) as { frameTree?: { frame?: { id?: unknown } } };
      const id = tree?.frameTree?.frame?.id;
      if (typeof id === "string") this.mainFrameId = id;
      await this.send("Page.setLifecycleEventsEnabled", { enabled: true });
    } catch {
    }
  }

  beginStep(promptText = ""): void {
    this.dialogs = [];
    this.promptText = promptText;
  }

  takeDialogs(): DialogSeen[] {
    const d = this.dialogs;
    this.dialogs = [];
    return d;
  }

  isNetworkIdle(): boolean | null {
    return this.networkIdle;
  }

  takeDragData(): unknown {
    const d = this.dragData;
    this.dragData = null;
    return d;
  }

  async send(method: string, params?: object, frameSession?: string | null): Promise<unknown> {
    if (!ALLOWED_CDP_METHODS.has(method)) throw new CdpNotAllowedError(method);
    if (frameSession && !this.frames.has(frameSession)) throw new UnknownFrameError();
    const target: DebuggerTarget = frameSession
      ? { tabId: this.tabId, sessionId: frameSession }
      : { tabId: this.tabId };
    return this.api.sendCommand(target, method, params ?? {});
  }

  frameSessions(): string[] {
    return [...this.frames];
  }

  waitForLoad(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.loadWaiters = this.loadWaiters.filter((w) => w !== done);
        resolve();
      }, ms);
      this.loadWaiters.push(done);
    });
  }

  markDetached(): void {
    if (this.attached) this.api.onEvent.removeListener(this.onEvent);
    this.attached = false;
    this.frames.clear();
    this.networkIdle = null;
    this.dragData = null;
  }

  async detach(): Promise<void> {
    if (!this.attached) return;
    this.markDetached();
    try {
      await this.api.detach({ tabId: this.tabId });
    } catch {
    }
  }
}
