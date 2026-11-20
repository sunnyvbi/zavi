
import type { CardApproval, CardOutcome } from "@/lib/workspace/channelActionsApi";

export function shortDay(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(value);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function clockTime(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return d.toDateString() === now.toDateString() ? time : `${shortDay(iso)}, ${time}`;
}

const VERDICT_WORDS: Record<NonNullable<CardOutcome["verdict"]>, string> = {
  worked: "Worked",
  did_not_work: "Did not work",
  not_measured: "Not measured",
};

export function outcomeLine(o: CardOutcome): string {
  if (o.verdict) return `Autopilot test · ${VERDICT_WORDS[o.verdict]}.${o.result ? ` ${o.result}` : ""}`;
  const goal = `${o.spend_line ? `${o.spend_line} ` : ""}Goal: ${o.success_if.replace(/[.\s]+$/, "")}.`;
  if (!o.readout_on) return `Autopilot test · results are checked once this is live. ${goal}`;
  return `Autopilot test · checking results ${shortDay(o.readout_on)}. ${goal}`;
}

export function approverWho(by: CardApproval["by"], name: string | null): string {
  if (by === "you") return "You";
  if (by === "autopilot") return "Autopilot";
  if (by === "zavi_team") return "The Zavi team";
  return name?.trim() || "A teammate";
}

export function approverLine(approval: CardApproval | null | undefined): string | null {
  if (!approval) return null;
  const at = clockTime(approval.at);
  return `${approverWho(approval.by, approval.name)} approved${at ? ` at ${at}` : ""}`;
}
