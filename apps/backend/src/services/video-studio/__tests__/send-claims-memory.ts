import type { SendClaimRow, SendClaims } from "../studio";

export function memorySendClaims(now: () => number = Date.now) {
  const rows = new Map<string, SendClaimRow>();
  let seq = 0;
  const log: Array<{ op: string; key: string }> = [];
  const at = () => new Date(now()).toISOString();
  const claims: SendClaims = {
    async claim(user_id, key) {
      await Promise.resolve();
      const k = `${user_id}:${key}`;
      log.push({ op: "claim", key: k });
      if (rows.has(k)) return null;
      const token = `t${++seq}`;
      rows.set(k, { token, claimed_at: at(), status: "in_progress", result: null, completed_at: null });
      return token;
    },
    async read(user_id, key) {
      await Promise.resolve();
      const r = rows.get(`${user_id}:${key}`);
      return r ? JSON.parse(JSON.stringify(r)) : null;
    },
    async settle(user_id, key, token, result) {
      await Promise.resolve();
      const r = rows.get(`${user_id}:${key}`);
      if (r && r.token === token) Object.assign(r, { status: "done", result: JSON.parse(JSON.stringify(result)), completed_at: at() });
    },
    async release(user_id, key, token) {
      await Promise.resolve();
      const k = `${user_id}:${key}`;
      if (rows.get(k)?.token === token) rows.delete(k);
    },
    async takeOver(user_id, key, seen_token) {
      await Promise.resolve();
      const k = `${user_id}:${key}`;
      const r = rows.get(k);
      if (!r || r.token !== seen_token) return null;
      const token = `t${++seq}`;
      rows.set(k, { token, claimed_at: at(), status: "in_progress", result: null, completed_at: null });
      return token;
    },
  };
  return { claims, rows, log };
}
