
import { randomUUID } from "node:crypto";

export const PER_IP_PER_HOUR = 3;
const WINDOW_MS = 60 * 60 * 1000;

export const WORKSPACE_LIMIT_MESSAGE =
  "Too many new workspaces from this network. Please try again in an hour, or email support@zaviagent.com.";

const byIp = new Map<string, Map<string, number>>();

function live(ip: string, now: number): Map<string, number> {
  const m = byIp.get(ip) ?? new Map<string, number>();
  for (const [k, at] of m) if (now - at >= WINDOW_MS) m.delete(k);
  byIp.set(ip, m);
  return m;
}

export type WorkspaceSlot = { commit(tenantId: string): void; release(): void };

export function reserveWorkspaceSlot(ip: string | undefined, now = Date.now()): WorkspaceSlot | null {
  const noop: WorkspaceSlot = { commit() {}, release() {} };
  if (!ip) return noop;
  const m = live(ip, now);
  if (m.size >= PER_IP_PER_HOUR) return null;
  const pending = `pending:${randomUUID()}`;
  m.set(pending, now);
  return {
    commit(tenantId: string) {
      m.delete(pending);
      if (!m.has(tenantId)) m.set(tenantId, now);
    },
    release() {
      m.delete(pending);
    },
  };
}

export function _resetWorkspaceCreateLimit(): void {
  byIp.clear();
}
