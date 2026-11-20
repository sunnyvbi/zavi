"use client";

export type AgentHealth = {
  slug: string;
  badge: "green" | "yellow" | "red" | "inactive";
  reason: string;
  detail: string;
  missing_required: string[];
  missing_optional: string[];
  last_run_status: "success" | "failed" | null;
};

function isNeutral(h: AgentHealth): boolean {
  return h.badge === "inactive" || h.reason === "no_signal";
}

function dotColor(h: AgentHealth): string {
  if (isNeutral(h)) return "bg-slate-300";
  if (h.badge === "green") return "bg-emerald-500";
  if (h.badge === "yellow") return "bg-amber-400";
  if (h.badge === "red") return "bg-rose-500";
  return "bg-slate-300";
}

function tooltipText(h: AgentHealth): string {
  const parts = [h.detail || h.reason];
  if (h.missing_required.length > 0) {
    parts.push(`missing required: ${h.missing_required.join(", ")}`);
  }
  if (h.missing_optional.length > 0) {
    parts.push(`missing optional: ${h.missing_optional.join(", ")}`);
  }
  return parts.join(" · ");
}

export function HealthBadge({ health }: { health: AgentHealth | undefined }) {
  if (!health) {
    return (
      <span
        title="health unknown"
        className="inline-block h-2.5 w-2.5 rounded-full bg-slate-200 align-middle"
        aria-label="health unknown"
      />
    );
  }
  return (
    <span
      title={tooltipText(health)}
      aria-label={`health: ${isNeutral(health) ? health.reason : health.badge}`}
      className={`inline-block h-2.5 w-2.5 rounded-full align-middle ${dotColor(health)}`}
    />
  );
}

export function HealthBadgeHeader({ health }: { health: AgentHealth | undefined }) {
  if (!health) return null;
  const neutral = isNeutral(health);
  const label = neutral ? health.reason.replace(/_/g, " ") : health.badge;
  const cls = neutral
    ? "bg-slate-100 text-slate-600 border-slate-200"
    : health.badge === "green"
      ? "bg-emerald-50 text-emerald-800 border-emerald-200"
      : health.badge === "yellow"
        ? "bg-amber-50 text-amber-900 border-amber-200"
        : "bg-rose-50 text-rose-800 border-rose-200";
  return (
    <span
      title={tooltipText(health)}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-sm ${cls}`}
    >
      <span className={`h-2 w-2 rounded-full ${dotColor(health)}`} />
      {label}
    </span>
  );
}
