"use client";
import { SLIP_PRIMARY, SLIP_QUIET, SlipSlab } from "@/components/agents/slip/SlipParts";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import {
  BusinessPolicyFields,
  validBusinessPolicy,
  type Policy,
} from "../growth/BusinessPolicyFields";

type Snapshot = {
  proposal: {
    id: string;
    status: string;
    body: {
      policy: Policy;
      revision: number;
      rationale: string;
      saved_revision?: number;
      saved_at?: string;
    };
  };
  current_policy: (Policy & { revision: number }) | null;
  can_manage: boolean;
};

export function BusinessControlsApprovalCard({
  decisionId,
  onResolved,
}: {
  decisionId: string;
  onResolved?: (resolution: "approved" | "rejected") => void;
}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const submitting = useRef(false);
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const r = await apiFetch(
        `/api/workspace/growth-controls/proposals/${decisionId}`,
      );
      const j = await r.json();
      if (!r.ok)
        throw new Error(j.error?.message ?? "Could not load this proposal.");
      setSnapshot(j);
      setPolicy(j.proposal.body.policy);
      return j as Snapshot;
    } finally {
      setLoading(false);
    }
  }, [decisionId]);
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, [load]);

  const act = async (action: "approve" | "reject") => {
    if (!snapshot || !policy || submitting.current) return;
    if (action === "approve" && !validBusinessPolicy(policy)) {
      setError("Check the numeric limits before saving.");
      return;
    }
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      const r = await apiFetch(`/api/approvals/${decisionId}/${action}`, {
        method: "POST",
        ...(action === "approve"
          ? {
              body: JSON.stringify({
                business_controls: {
                  policy,
                  expected_policy: snapshot.proposal.body.policy,
                  revision: snapshot.proposal.body.revision,
                },
              }),
            }
          : {}),
      });
      const j = await r.json();
      if (!r.ok)
        throw new Error(j.error?.message ?? "Could not save this proposal.");
      const updated = await load();
      if (
        updated.proposal.status === "acted" &&
        updated.proposal.body.saved_revision != null
      )
        onResolved?.("approved");
      else if (updated.proposal.status === "rejected") onResolved?.("rejected");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  const saved =
    snapshot?.proposal.status === "acted" &&
    snapshot.proposal.body.saved_revision != null;
  const pending = snapshot?.proposal.status === "proposed";
  const stale =
    pending &&
    snapshot?.proposal.body.revision !==
      (snapshot?.current_policy?.revision ?? 0);
  const disabled = !snapshot?.can_manage || !pending || busy || stale;
  return (
    <section
      aria-label="Business results and experiments approval"
      className="my-3 w-full min-w-0 overflow-hidden rounded-2xl border border-[#efe2c3] bg-white text-sm text-ink shadow-[0_1px_2px_rgba(43,36,22,0.06),0_10px_28px_-16px_rgba(43,36,22,0.25)]"
    >
      <SlipSlab
        stage={saved ? "done" : pending ? "waiting" : "closed"}
        literal
        status={saved ? "Saved" : pending ? "Needs your yes" : !snapshot ? (loading ? "Loading" : "Couldn't load") : "Closed"}
        platform="Zavi"
        mark="Z"
        target={saved ? "Saved settings" : "Settings approval"}
        title="Business results and experiments"
        hero={null}
      />
      <div className="px-4 pb-4 pt-2 sm:px-5">
      {error && (
        <p role="alert" className="my-2">
          {error}
        </p>
      )}
      {!snapshot || !policy ? (
        <>
          <p>
            {loading ? "Loading proposal…" : "Proposal could not be loaded."}
          </p>
          <button
            type="button"
            disabled={loading}
            onClick={() => void load().catch((e) => setError(e.message))}
          >
            Retry
          </button>
        </>
      ) : (
        <>
          {saved ? (
            <p role="status" className="my-2">
              Business controls saved. Revision{" "}
              {snapshot.proposal.body.saved_revision}. These are the approved
              values
              {snapshot.current_policy?.revision !==
              snapshot.proposal.body.saved_revision
                ? "; newer settings have since been saved"
                : ""}
              .
            </p>
          ) : pending ? (
            <p className="my-2">
              Proposed settings, not saved yet. Edit any value, then approve to
              save.
            </p>
          ) : (
            <p role="status" className="my-2">
              Proposal {snapshot.proposal.status}. This card did not save
              settings.
            </p>
          )}
          <p className="mt-2 font-medium">
            Zavi’s reasoning (not independently verified)
          </p>
          <p className="my-2 whitespace-pre-wrap">
            {snapshot.proposal.body.rationale}
          </p>
          {stale && (
            <p role="alert">
              Saved settings changed after this proposal. Ask Zavi for a new
              proposal before saving.
            </p>
          )}
          {!snapshot.can_manage && pending && (
            <p>Only a workspace owner or admin can approve these settings.</p>
          )}
          {pending && policy.enabled && (
            <p className="my-2">
              Enabling business-result controls requires a Pro plan. A disabled
              policy can be saved on any plan.
            </p>
          )}
          <fieldset disabled={disabled} className="my-3 space-y-3">
            <BusinessPolicyFields policy={policy} onChange={setPolicy} />
          </fieldset>
          <p className="my-2 text-inkMuted">
            CPA measures platform-attributed purchases, not profit or unique new
            customers. This saves policy settings only. It does not change the
            monthly budget or register an experiment. Automatic stops stay as
            shown until you change them.
          </p>
          {pending && (
            <div className="mt-3">
              <button
                type="button"
                disabled={disabled}
                onClick={() => void act("approve")}
                className={SLIP_PRIMARY}
              >
                {busy ? "Saving…" : "Approve and save"}
              </button>
              <div className="mt-1 flex justify-end">
                <button
                  type="button"
                  disabled={!snapshot.can_manage || busy}
                  onClick={() => void act("reject")}
                  className={SLIP_QUIET}
                >
                  Reject
                </button>
              </div>
            </div>
          )}
        </>
      )}
      </div>
    </section>
  );
}
