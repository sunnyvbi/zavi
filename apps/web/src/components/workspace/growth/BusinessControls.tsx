"use client";
import { useEffect, useState } from "react";
import { BusinessPolicyFields, fields, type Policy } from "./BusinessPolicyFields";
import { apiFetch } from "@/lib/api";

type ObjectRow = {
  platform: string;
  account_id: string;
  object_id: string;
  level: string;
  name: string | null;
  budget_kind: string;
  budget_usd: number | null;
};
type Snapshot = {
  policy: (Policy & { revision: number; updated_at?: string }) | null;
  recommendation: { policy: Policy; explanation: string };
  can_manage: boolean;
  objects: ObjectRow[];
  experiments: Array<{
    id: string;
    name: string;
    state: string;
    hypothesis?: string;
    ends_at?: string;
    stop_on_loss?: boolean;
    spent_usd: number;
    exposure_usd: number;
    budget_usd: number;
    reason: string | null;
  }>;
  limitations: string;
};
export function BusinessControls() {
  const [snap, setSnap] = useState<Snapshot | null>(null),
    [policy, setPolicy] = useState<Policy | null>(null);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const [target, setTarget] = useState(""),
    [name, setName] = useState(""),
    [hypothesis, setHypothesis] = useState("");
  const [lossStop, setLossStop] = useState(false),
    [budget, setBudget] = useState(""),
    [days, setDays] = useState("7");
  const load = async () => {
    const r = await apiFetch("/api/workspace/growth-controls");
    if (!r.ok) throw new Error("Could not load business controls.");
    const j = (await r.json()) as Snapshot;
    setSnap(j);
    const {
      revision: _revision,
      updated_at: _updatedAt,
      ...saved
    } = j.policy ?? { revision: 0, ...j.recommendation.policy };
    setPolicy(saved);
  };
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, []);
  const save = async () => {
    if (!policy || busy) return;
    if (
      fields.some(
        ([key, , min, max]) =>
          !Number.isFinite(policy[key]) ||
          Number(policy[key]) < min ||
          Number(policy[key]) > max,
      )
    ) {
      setError("Check the numeric limits before saving.");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const r = await apiFetch("/api/workspace/growth-controls", {
        method: "PUT",
        body: JSON.stringify({ policy, revision: snap?.policy?.revision ?? 0 }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error?.message ?? "Could not save.");
      await load();
      setNotice("Business controls saved.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const register = async () => {
    const object = snap?.objects.find(
      (o) => `${o.platform}:${o.account_id}:${o.object_id}` === target,
    );
    if (!object || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const r = await apiFetch("/api/workspace/growth-controls/experiments", {
        method: "POST",
        body: JSON.stringify({
          name,
          hypothesis,
          platform: object.platform,
          account_id: object.account_id,
          object_id: object.object_id,
          budget_usd: Number(budget),
          stop_on_loss: lossStop,
          ends_at: new Date(Date.now() + Number(days) * 86400000).toISOString(),
        }),
      });
      const j = await r.json();
      if (!r.ok)
        throw new Error(
          j.error?.message ?? "Could not register the experiment.",
        );
      await load();
      setNotice(
        "Experiment budget registered. A paused campaign still needs activation.",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      aria-label="Business results and experiment controls"
      className="mt-4 space-y-3 border-t border-rule pt-4 text-sm"
    >
      <p className="font-semibold">Business results and experiments</p>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {!snap || !policy ? (
        <p>Loading controls…</p>
      ) : (
        <>
          <p>{snap.recommendation.explanation}</p>
          <p>
            Results use platform-attributed purchases over the last 7 days.
            Unspent budget is allowed when results miss your limits. No-result
            stops require at least twice the CPA limit and the minimum spend.
          </p>
          <fieldset disabled={!snap.can_manage || busy} className="space-y-3">
            <BusinessPolicyFields policy={policy} onChange={setPolicy} />
            <button
              type="button"
              className="rounded border px-3 py-2"
              onClick={() => setPolicy({ ...snap.recommendation.policy })}
            >
              Restore recommendations
            </button>{" "}
            <button
              type="button"
              className="rounded bg-ink px-3 py-2 text-white"
              onClick={() => void save()}
            >
              Save controls
            </button>
          </fieldset>
          <p>{snap.limitations}</p>
          <button
            type="button"
            disabled={busy}
            className="rounded border px-3 py-2"
            onClick={() => void load().catch((e) => setError(e.message))}
          >
            Refresh saved controls and experiment status
          </button>
          <details>
            <summary className="cursor-pointer">
              Register an experiment budget
            </summary>
            <p className="my-2">
              Choose a dedicated daily-budget campaign or ad set. A
              campaign-level test includes every ad set in that campaign.
              Registration reserves part of your exploration allowance and does
              not launch an ad.
            </p>
            <fieldset
              disabled={
                !snap.can_manage ||
                busy ||
                !snap.policy?.enabled ||
                !snap.policy?.automatic_stops
              }
              className="space-y-2"
            >
              <label className="block font-medium">
                Experiment name
                <input
                  className="block w-full rounded border p-2"
                  value={name}
                  maxLength={160}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <label className="block font-medium">
                Hypothesis
                <input
                  className="block w-full rounded border p-2"
                  value={hypothesis}
                  maxLength={500}
                  onChange={(e) => setHypothesis(e.target.value)}
                />
              </label>
              <label className="block font-medium">
                Campaign budget
                <select
                  className="block w-full rounded border p-2"
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                >
                  <option value="">Choose a campaign or ad set</option>
                  {snap.objects
                    .filter((o) => o.budget_kind === "daily")
                    .map((o) => (
                      <option
                        key={`${o.platform}:${o.account_id}:${o.object_id}`}
                        value={`${o.platform}:${o.account_id}:${o.object_id}`}
                      >
                        {o.name ?? "Unnamed campaign"} ({o.platform}, $
                        {o.budget_usd}/day)
                      </option>
                    ))}
                </select>
              </label>
              <label className="block font-medium">
                Total experiment budget ($)
                <input
                  className="block rounded border p-2"
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={budget}
                  onChange={(e) => setBudget(e.target.value)}
                />
              </label>
              <label className="block font-medium">
                Duration (days)
                <input
                  className="block rounded border p-2"
                  type="number"
                  min="1"
                  max="30"
                  value={days}
                  onChange={(e) => setDays(e.target.value)}
                />
              </label>
              <label className="flex gap-2">
                <input
                  type="checkbox"
                  checked={lossStop}
                  onChange={(e) => setLossStop(e.target.checked)}
                />
                Also stop when the campaign’s last 7 days miss the saved
                business-result limit (Meta/Google)
              </label>
              <button
                type="button"
                className="rounded border px-3 py-2"
                onClick={() => void register()}
              >
                Register budget and stop rule
              </button>
            </fieldset>
          </details>
          {snap.experiments.map((e) => (
            <div key={e.id} className="rounded border p-3">
              <p className="font-medium">
                {e.name}: {e.state.replaceAll("_", " ")}
              </p>
              <p>
                ${e.spent_usd.toFixed(2)} reported of ${e.budget_usd.toFixed(2)}
                ; ${e.exposure_usd.toFixed(2)} including reporting allowance.
              </p>
              {e.hypothesis && <p>{e.hypothesis}</p>}
              {e.ends_at && (
                <p>
                  Stops at the spend limit or by{" "}
                  {new Date(e.ends_at).toLocaleString()}
                  {e.stop_on_loss
                    ? ", or when the saved business-loss rule is met"
                    : ""}
                  .
                </p>
              )}
              {e.reason && <p>{e.reason}</p>}
            </div>
          ))}
        </>
      )}
    </section>
  );
}
