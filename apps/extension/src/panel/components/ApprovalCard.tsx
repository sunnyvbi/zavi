
import { useState, type JSX } from "react";
import {
  ApiError,
  SHIP_RED_CODE,
  approveDecision,
  rejectDecision,
  type Decision,
} from "../api";

const HIGH_RISK = ["budget", "spend", "pr.merge", "payment", "delete", "ship-pr"];

export function isHighRisk(decisionClass: string): boolean {
  const c = (decisionClass || "").toLowerCase();
  return HIGH_RISK.some((k) => c.includes(k));
}

export function summarizeDecision(body: unknown): string {
  if (typeof body === "string" && body.trim()) return body.trim();
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    for (const key of ["summary", "title", "description", "text", "message"]) {
      const v = b[key];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  return "Review the details before deciding.";
}

function agentName(slug: string | null): string {
  if (!slug) return "Zavi";
  return slug
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export const MONEY_STEP_CLASS = "extension.money_step";
export const MONEY_CARD_TITLE = "Confirm before I spend money";
export const MONEY_GO_AHEAD = "Go ahead";
export const MONEY_DONT = "Don't do it";

export function moneyCardBody(body: unknown): string {
  const b = (body ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const host = str(b.host);
  const label = str(b.label);
  if (b.op === "nav") return `On ${host} I'm about to open the checkout page.`;
  if (b.op === "type_ref" || b.op === "select_option") return `On ${host} I'm about to change "${label}" to ${str(b.value)}.`;
  const valueLine = str(b.value_line) ? ` ${str(b.value_line)}` : "";
  return `On ${host} I'm about to click "${label}".${valueLine}`;
}

function sealOf(body: unknown): string | undefined {
  const f = (body as { fingerprint?: unknown } | null)?.fingerprint;
  return typeof f === "string" && f ? f : undefined;
}

type Stage = "idle" | "confirming" | "ship_red";

type Props = {
  decision: Decision;
  getToken: () => Promise<string>;
  onDecided: () => void;
};

export function ApprovalCard({ decision, getToken, onDecided }: Props): JSX.Element {
  const [stage, setStage] = useState<Stage>("idle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shipRedMessage, setShipRedMessage] = useState<string | null>(null);

  const highRisk = isHighRisk(decision.decision_class);
  const moneyStep = decision.decision_class === MONEY_STEP_CLASS;

  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await action();
      onDecided();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.code === SHIP_RED_CODE) {
        setShipRedMessage(e.message);
        setStage("ship_red");
      } else {
        setError("Couldn't save that decision. Try again.");
      }
    } finally {
      setBusy(false);
    }
  }

  function onApprove(): void {
    if (busy) return;
    if (highRisk && stage === "idle") {
      setStage("confirming");
      return;
    }
    void run(async () => approveDecision(await getToken(), decision.id));
  }

  function onShipAnyway(): void {
    if (busy) return;
    void run(async () =>
      approveDecision(await getToken(), decision.id, { shipAnyway: true }),
    );
  }

  function onReject(): void {
    if (busy) return;
    setStage("idle");
    void run(async () => rejectDecision(await getToken(), decision.id));
  }

  if (moneyStep) {
    return (
      <div className="zv-approval" data-decision-id={decision.id}>
        <p className="zv-approval-title">{MONEY_CARD_TITLE}</p>
        {}
        <p className="zv-approval-summary">{moneyCardBody(decision.body)}</p>
        <div className="zv-approval-actions">
          <button type="button" className="zv-approval-reject" onClick={onReject} disabled={busy}>
            {MONEY_DONT}
          </button>
          <button
            type="button"
            className="zv-approval-approve"
            disabled={busy}
            onClick={() => {
              if (busy) return;
              const seal = sealOf(decision.body);
              void run(async () => approveDecision(await getToken(), decision.id, { expectedFingerprint: seal }));
            }}
          >
            {busy ? "Saving..." : MONEY_GO_AHEAD}
          </button>
        </div>
        {error && (
          <p className="zv-error" role="alert">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="zv-approval" data-decision-id={decision.id}>
      <p className="zv-approval-kicker">Approval needed</p>
      <p className="zv-approval-title">
        {agentName(decision.agent_slug)} · {decision.decision_class || "decision"}
      </p>
      {}
      <p className="zv-approval-summary">{summarizeDecision(decision.body)}</p>

      {stage === "ship_red" ? (
        <div className="zv-approval-warn" role="alert">
          <p>
            {shipRedMessage ||
              "This change broke a test that was passing before. Approve it anyway?"}
          </p>
          <div className="zv-approval-actions">
            <button
              type="button"
              className="zv-approval-cancel"
              onClick={() => setStage("idle")}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type="button"
              className="zv-approval-shipanyway"
              onClick={onShipAnyway}
              disabled={busy}
            >
              {busy ? "Saving..." : "Approve anyway"}
            </button>
          </div>
        </div>
      ) : (
        <div className="zv-approval-actions">
          <button
            type="button"
            className="zv-approval-reject"
            onClick={onReject}
            disabled={busy}
          >
            Reject
          </button>
          <button
            type="button"
            className="zv-approval-approve"
            onClick={onApprove}
            disabled={busy}
          >
            {busy
              ? "Saving..."
              : highRisk
                ? stage === "confirming"
                  ? "Confirm"
                  : "Review"
                : "Approve"}
          </button>
        </div>
      )}

      {stage === "confirming" && !busy && (
        <p className="zv-approval-note">
          This one is hard to undo. Press Confirm to approve it.
        </p>
      )}
      {error && (
        <p className="zv-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
