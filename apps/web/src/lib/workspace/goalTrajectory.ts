
export type GoalPaceLine = { start_value: number; start_day: string; target: number; due_day: string };

export type GoalTrajectory = {
  kind: "gauge" | "period_total" | "ambiguous";
  progress: number | null;
  line: GoalPaceLine | null;
  projected: number | null;
  behind_required: boolean;
  reading_day: string;
  pace_usable: boolean;
};

const DAY = 86_400_000;
const dayMs = (d: string) => Date.parse(`${d.slice(0, 10)}T00:00:00Z`);

export function lineValueAt(line: GoalPaceLine, t: number): number {
  const total = Math.round((dayMs(line.due_day) - dayMs(line.start_day)) / DAY) + 1;
  const elapsed = Math.floor((t - dayMs(line.start_day)) / DAY) + 1;
  const fraction = Math.min(1, Math.max(0, elapsed / total));
  return line.start_value + (line.target - line.start_value) * fraction;
}
