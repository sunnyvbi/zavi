
import { adChangeMoney, adMoney, type AdChangeMoney } from "@zavi/shared";

export type MoveCardRow = { id: string; decision_class: string; body: Record<string, unknown> | null; status: string };

const RAISE_GROUP = /^raise:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function moveKeyOf(body: Record<string, unknown> | null | undefined): string | null {
  const b = body ?? {};
  if (typeof b.move_group === "string" && RAISE_GROUP.test(b.move_group)) return b.move_group;
  if (b.founder_chat_order === true && typeof b.move_group === "string" && b.move_group) return b.move_group;
  const alone = b.run_alone;
  if (alone && typeof alone === "object" && typeof (alone as { move_group_left?: unknown }).move_group_left === "string") {
    return (alone as { move_group_left: string }).move_group_left || null;
  }
  return null;
}

export function perDay(n: number, currency?: unknown): string {
  return n === 0 ? adMoney(0, currency) : `${adMoney(n, currency)}/day`;
}

export const lowers = (m: AdChangeMoney | null): boolean => !!m && (m.verb === "Pause" || m.verb === "Cut");

export function cutsFirst<T extends MoveCardRow>(rows: T[]): T[] {
  const m = (r: T) => adChangeMoney(r.decision_class, r.body);
  return [...rows.filter((r) => lowers(m(r))), ...rows.filter((r) => !lowers(m(r)))];
}

const IN_FLIGHT = new Set(["approved", "dispatching"]);
const NOT_APPLIED = new Set(["rejected", "expired", "superseded"]);
const UNCONFIRMED = "dispatch_failed";
const VERB_WORD: Record<AdChangeMoney["verb"], string> = { "Turn on": "turn on", Pause: "pause", Raise: "raise", Cut: "cut", Keep: "keep" };

export type MoveHeaderView = {
  total: string | null;
  decided: number;
  count: number;
  status: string;
  tone: "up" | "plain";
};

const signed = (n: number, cur: unknown) => (n > 0 ? `+${adMoney(n, cur)}` : n < 0 ? `−${adMoney(-n, cur)}` : adMoney(0, cur));
const curOf = (m: AdChangeMoney | null) => (typeof m?.currency === "string" && m.currency ? m.currency.toUpperCase() : "USD");

export function moveHeader(rows: MoveCardRow[]): MoveHeaderView {
  const legs = rows.map((r) => ({ r, m: adChangeMoney(r.decision_class, r.body) }));
  const oneCurrency = new Set(legs.map((l) => curOf(l.m))).size === 1;
  const cur = legs.find((l) => l.m)?.m?.currency;
  const amounts = (ls: typeof legs) => oneCurrency && ls.every((l) => l.m && l.m.delta !== null);
  const sum = (ls: typeof legs) => ls.reduce((t, l) => t + (l.m!.delta as number), 0);

  let total: string | null = null;
  if (amounts(legs)) {
    const parts = new Map<string, number>();
    for (const l of legs) {
      const w = VERB_WORD[l.m!.verb];
      parts.set(w, (parts.get(w) ?? 0) + Math.abs(l.m!.delta as number));
    }
    const list = [...parts].filter(([, v]) => v > 0).map(([w, v]) => `${w} ${adMoney(v, cur)}`);
    total = `This move: ${signed(sum(legs), cur)}/day${list.length ? ` (${list.join(", ")})` : ""}`;
  }

  const applied = legs.filter((l) => l.r.status === "acted");
  const inFlight = legs.filter((l) => IN_FLIGHT.has(l.r.status));
  const notApplied = legs.filter((l) => NOT_APPLIED.has(l.r.status));
  const unconfirmed = legs.filter((l) => l.r.status === UNCONFIRMED);
  const openLower = legs.filter((l) => l.r.status === "proposed" && lowers(l.m));
  const open = legs.filter((l) => l.r.status === "proposed");

  const lines: string[] = [];
  let tone: MoveHeaderView["tone"] = "plain";
  if (legs.length > 0 && applied.length === legs.length) {
    const net = amounts(legs) ? sum(legs) : null;
    lines.push(net === null || net === 0 ? "Done. Every change in this move went through." : `Done. Daily spend is ${adMoney(Math.abs(net), cur)} ${net < 0 ? "lower" : "higher"}.`);
  } else {
    if (applied.length === 0) {
      const applying = inFlight.some((l) => l.r.status === "dispatching");
      lines.push(applying ? "Being applied now. Nothing has changed yet." : inFlight.length ? "Approved, waiting to be applied. Nothing has changed yet." : "Nothing has changed yet.");
    } else {
      const now = amounts(applied) ? sum(applied) : null;
      if (now === null) {
        lines.push("Right now: part of this move went through.");
        if (applied.some((l) => !lowers(l.m))) tone = "up";
      } else if (now > 0) {
        lines.push(`Right now: spend is up ${adMoney(now, cur)}/day.`);
        tone = "up";
      } else if (now < 0) {
        lines.push(`Right now: spend is down ${adMoney(-now, cur)}/day.`);
      } else {
        lines.push("Right now: daily spend is unchanged.");
      }
      if (inFlight.length) lines.push("More is being applied now.");
    }
    if (notApplied.length) lines.push(`${notApplied.length} ${notApplied.length === 1 ? "change was" : "changes were"} not applied.`);
    if (unconfirmed.length) lines.push(`Zavi could not confirm whether ${unconfirmed.length === 1 ? "1 change" : `${unconfirmed.length} changes`} went through. Check the ad account.`);
    if (openLower.length) {
      const noun = openLower.every((l) => l.m!.verb === "Pause") ? ["pause", "pauses"] : openLower.every((l) => l.m!.verb === "Cut") ? ["cut", "cuts"] : ["change", "changes"];
      if (applied.length > 0 || inFlight.length > 0) lines.push(`Approve the ${openLower.length === 1 ? noun[0] : `${openLower.length} ${noun[1]}`} to finish the move.`);
    } else if (open.length && applied.length > 0) {
      lines.push("The rest is still open.");
    }
  }
  return { total, decided: legs.length - open.length, count: legs.length, status: lines.join(" "), tone };
}

export function firstOfEachMove<T extends { body: Record<string, unknown> | null }>(rows: readonly T[]): T[] {
  const seen = new Set<string>();
  return rows.filter((r) => {
    const k = moveKeyOf(r.body);
    if (!k) return true;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
