
import { OwnTabCdp, realDebuggerApi, type DebuggerTarget } from "../../src/panel/executor/cdp";
import { executeOp, type OpOutcome } from "../../src/panel/executor/ops";

const cdps = new Map<number, OwnTabCdp>();
const detachEvents: { tabId: number; sessionId?: string; reason: string }[] = [];

chrome.debugger.onDetach.addListener((source: DebuggerTarget, reason: string) => {
  detachEvents.push({ tabId: source.tabId, sessionId: source.sessionId, reason });
  if (!source.sessionId) cdps.get(source.tabId)?.markDetached();
});

function cdpFor(tabId: number): OwnTabCdp {
  let c = cdps.get(tabId);
  if (!c) {
    c = new OwnTabCdp(tabId, realDebuggerApi());
    cdps.set(tabId, c);
  }
  return c;
}

async function topUrl(tabId: number): Promise<string | null> {
  try {
    const t = await chrome.tabs.get(tabId);
    return t.pendingUrl || t.url || null;
  } catch {
    return null;
  }
}

const api = {
  async findTab(urlPattern: string): Promise<number | null> {
    const tabs = await chrome.tabs.query({ url: urlPattern });
    return tabs[0]?.id ?? null;
  },
  async attach(tabId: number): Promise<{ ok: boolean; error?: string }> {
    try {
      await cdpFor(tabId).attach();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },
  async detach(tabId: number): Promise<void> {
    await cdpFor(tabId).detach();
  },
  isAttached(tabId: number): boolean {
    return cdpFor(tabId).isAttached();
  },
  frames(tabId: number): string[] {
    return cdpFor(tabId).frameSessions();
  },
  run(tabId: number, op: unknown): Promise<OpOutcome> {
    return executeOp(cdpFor(tabId), op, () => topUrl(tabId), { settle: true });
  },
  async debuggerTargets(): Promise<{ tabId?: number; attached: boolean; url: string }[]> {
    const ts = await chrome.debugger.getTargets();
    return ts.map((t) => ({ tabId: t.tabId, attached: t.attached, url: t.url }));
  },
  async rawProbe(tabId: number): Promise<string> {
    try {
      await chrome.debugger.sendCommand({ tabId }, "Page.getLayoutMetrics", {});
      return "attached";
    } catch (e) {
      return `error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
  detachEvents(): typeof detachEvents {
    return detachEvents.slice();
  },
};

(window as unknown as { __zavi: typeof api }).__zavi = api;
document.body.dataset.ready = "1";
