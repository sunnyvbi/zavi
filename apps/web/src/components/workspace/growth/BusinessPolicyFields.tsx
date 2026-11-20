"use client";
export type Policy = {
  enabled: boolean;
  metric: "cpa" | "roas";
  max_cpa_usd: number;
  min_roas: number;
  min_results: number;
  min_spend_usd: number;
  min_age_days: number;
  exploration_percent: number;
  step_percent: number;
  reporting_delay_hours: number;
  automatic_stops: boolean;
};
export const fields: Array<[keyof Policy, string, number, number, number]> = [
  ["max_cpa_usd", "Maximum cost per purchase ($)", 0.01, 1000000, 0.01],
  ["min_roas", "Minimum revenue per $1 of ads", 0.01, 1000, 0.01],
  ["min_results", "Minimum purchases", 1, 10000, 1],
  ["min_spend_usd", "Minimum measured spend ($)", 0.01, 1000000, 0.01],
  ["min_age_days", "Minimum campaign age (days)", 1, 90, 1],
  [
    "exploration_percent",
    "Monthly budget reserved for experiments (%)",
    0,
    100,
    1,
  ],
  ["step_percent", "Maximum budget change per step (%)", 1, 100, 1],
  [
    "reporting_delay_hours",
    "Allowance for delayed reporting (hours)",
    1,
    72,
    1,
  ],
];

export function validBusinessPolicy(policy: Policy): boolean {
  return fields.every(([key, , min, max, step]) => {
    const n = Number(policy[key]);
    return (
      Number.isFinite(n) &&
      n >= min &&
      n <= max &&
      (step !== 1 || key === "exploration_percent" || Number.isInteger(n))
    );
  });
}
export function BusinessPolicyFields({
  policy,
  onChange,
}: {
  policy: Policy;
  onChange: (policy: Policy) => void;
}) {
  return (
    <>
      <label className="flex gap-2">
        <input
          type="checkbox"
          checked={policy.enabled}
          onChange={(e) => onChange({ ...policy, enabled: e.target.checked })}
        />
        Use business-result controls
      </label>
      <label className="block font-medium">
        Optimise for
        <select
          className="ml-2 rounded border p-2"
          value={policy.metric}
          onChange={(e) =>
            onChange({
              ...policy,
              metric: e.target.value as Policy["metric"],
            })
          }
        >
          <option value="cpa">Cost per purchase (CPA)</option>
          <option value="roas">Return on ad spend</option>
        </select>
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        {fields.map(([key, label, min, max, step]) => (
          <label key={key} className="block font-medium">
            {label}
            <input
              className="mt-1 block w-full rounded border p-2"
              type="number"
              min={min}
              max={max}
              step={step}
              value={
                typeof policy[key] === "number" && !Number.isFinite(policy[key])
                  ? ""
                  : String(policy[key])
              }
              onChange={(e) =>
                onChange({
                  ...policy,
                  [key]:
                    e.target.value === "" ? Number.NaN : Number(e.target.value),
                })
              }
            />
          </label>
        ))}
      </div>
      <label className="flex gap-2">
        <input
          type="checkbox"
          checked={policy.automatic_stops}
          onChange={(e) =>
            onChange({ ...policy, automatic_stops: e.target.checked })
          }
        />
        Allow Autopilot to pause campaigns at experiment limits or the saved
        business-result loss limit
      </label>
      <p>
        Saving these controls authorises eligible budget increases and
        reductions. Pauses require the permission above. Autopilot and an active
        Growth budget must also be on.
      </p>
    </>
  );
}
