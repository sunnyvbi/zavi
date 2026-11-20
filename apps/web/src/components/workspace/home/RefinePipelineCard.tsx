"use client";

import {
  type ChangedFile,
  fileActionClass,
  changedFilesLabel,
} from "./refineFiles";
import {
  type GateEvidenceView,
  type DeployStatusView,
  relativeTime,
  refineStatusBadge,
  formatTurnMessage,
  deriveGateLaneState,
  deployStateBadge,
} from "./builderThreadFormat";

export type RefineCardTurn = {
  id: string;
  message: string;
  status: string;
  created_at: string;
  summary: string | null;
  pr_url: string | null;
  files?: ChangedFile[];
  gate_evidence?: GateEvidenceView | null;
  preview_url?: string | null;
  failure_message?: string | null;
  no_ship_reason?: string | null;
};

type RefinePipelineCardProps = {
  turn: RefineCardTurn;
  isUndoable: boolean;
  onUndo?: (refineId: string) => void;
  onRetry?: (message: string) => void;
  undoingId?: string | null;
  runActive?: boolean;
  deploy?: DeployStatusView | null;
};

function GateCheck({
  ok,
  label,
}: {
  ok: boolean | null;
  label: string;
}) {
  const icon = ok === true ? "✓" : ok === false ? "✕" : "➖";
  const cls =
    ok === true ? "text-emerald-700" : ok === false ? "text-red-700" : "text-inkMuted";
  return (
    <li className="flex items-baseline gap-2 text-[12px]">
      <span aria-hidden className={`shrink-0 font-semibold ${cls}`}>
        {icon}
      </span>
      <span className="min-w-0 text-inkSoft">{label}</span>
    </li>
  );
}

export function GateResults({
  turn,
}: {
  turn: RefineCardTurn;
}) {
  const gate = turn.gate_evidence ?? null;
  const lane = deriveGateLaneState(turn.status, gate);

  if (lane === "checking") {
    return (
      <p
        className="mt-1.5 text-[12px] text-inkMuted"
        aria-live="polite"
        data-gate-state="checking"
      >
        Running checks (build, tests, preview)…
      </p>
    );
  }
  if (lane === "none" || !gate) return null;

  const blocked = lane === "gate_failed" || lane === "protected_hold";
  const previewOk =
    gate.preview_smoke.verdict === "pass"
      ? true
      : gate.preview_smoke.verdict === "fail"
        ? false
        : null;

  return (
    <div
      className={`mt-2 rounded-md border p-2.5 ${
        blocked
          ? "border-red-200 bg-red-50/60"
          : "border-emerald-200 bg-emerald-50/50"
      }`}
      data-gate-state={lane}
    >
      <p
        className={`text-[12px] font-semibold ${
          blocked ? "text-red-700" : "text-emerald-700"
        }`}
      >
        {lane === "protected_hold"
          ? "Blocked: human review required (protected path)"
          : lane === "gate_failed"
            ? "Blocked by gate"
            : "Checks passed, ready to review"}
      </p>

      {lane === "protected_hold" && gate.protected_paths && (
        <p className="mt-1 text-[11px] leading-[1.5] text-red-700/90">
          This change touches a protected path (env / secrets / migrations / auth
          / billing). It always needs a human, whatever the checks say.
        </p>
      )}

      <ul className="mt-1.5 space-y-0.5">
        <GateCheck ok={gate.build_ok} label={gate.build_ok ? "Build passed" : "Build broken"} />
        <GateCheck
          ok={gate.tests.failed === 0}
          label={`${gate.tests.passed} test${gate.tests.passed === 1 ? "" : "s"} passed${
            gate.tests.failed > 0 ? `, ${gate.tests.failed} failed` : ""
          }`}
        />
        <GateCheck
          ok={previewOk}
          label={
            gate.preview_smoke.verdict === "skipped"
              ? "Preview smoke skipped"
              : gate.preview_smoke.verdict === "pass"
                ? "Preview smoke passed"
                : "Preview smoke failed"
          }
        />
      </ul>

      {gate.protected_paths && gate.protected_paths.length > 0 && (
        <ul className="mt-1.5 space-y-0.5">
          {gate.protected_paths.map((h, i) => (
            <li
              key={`${h.path}-${i}`}
              className="min-w-0 break-all font-mono text-[11px] text-red-700/90"
            >
              {h.path}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function DeployStatus({ deploy }: { deploy: DeployStatusView | null | undefined }) {
  if (!deploy) return null;
  const badge = deployStateBadge(deploy.state);
  const liveUrl = deploy.state === "deploy_healthy" ? deploy.health_url : null;
  return (
    <div
      className="mt-2 rounded-md border border-ink/[0.10] bg-white/70 p-2.5"
      data-deploy-state={deploy.state}
    >
      <div className="flex items-center gap-2">
        {badge.spinning && (
          <span
            aria-hidden
            className="inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-[1.5px] border-blue-300 border-t-blue-600"
          />
        )}
        <span
          className={`shrink-0 rounded-full px-2 py-[1px] text-[11px] font-medium ${badge.cls}`}
        >
          {badge.label}
        </span>
        {liveUrl && (
          <a
            href={liveUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="min-w-0 truncate text-[12px] text-emerald-700 underline-offset-2 hover:underline"
          >
            View live app
          </a>
        )}
      </div>
      {deploy.state === "deploy_failed" && deploy.reason && (
        <p className="mt-1 text-[11px] leading-[1.5] text-red-700/90">
          {deploy.reason}
        </p>
      )}
    </div>
  );
}

export function RefinePipelineCard({
  turn,
  isUndoable,
  onUndo,
  onRetry,
  undoingId = null,
  runActive = false,
  deploy = null,
}: RefinePipelineCardProps) {
  const noShip = Boolean(turn.failure_message);
  const badge = refineStatusBadge(turn.status, {
    prUrl: turn.pr_url,
    noShip,
  });
  const msg = formatTurnMessage(turn.message);
  const rollbackAvailable = deploy
    ? deploy.rollback_available
    : turn.status === "done" && !turn.pr_url;
  const showUndo = isUndoable && rollbackAvailable;
  const showRetry = noShip && !runActive && typeof onRetry === "function";

  return (
    <div data-refine-id={turn.id}>
      {}
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 flex-1 break-words text-[13px] leading-[1.5] text-ink">
          {msg.text}
          {msg.planApplied && (
            <span className="ml-1.5 inline-flex items-center rounded-full bg-ink/[0.06] px-1.5 py-[1px] align-middle text-[11px] font-medium text-inkMuted">
              Plan applied
            </span>
          )}
        </p>
        <span
          title={badge.title}
          className={`shrink-0 rounded-full px-2 py-[1px] text-[11px] font-medium ${badge.cls}`}
        >
          {badge.label}
        </span>
      </div>

      {}
      <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-inkMuted">
        <span>{relativeTime(turn.created_at)}</span>
        {turn.pr_url && (
          <>
            <span aria-hidden>·</span>
            {}
            <span>Parked for Zavi to publish</span>
          </>
        )}
        {}
        {turn.preview_url && (
          <>
            <span aria-hidden>·</span>
            <a
              href={turn.preview_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-inkSoft underline-offset-2 hover:text-ink hover:underline"
            >
              view preview
            </a>
          </>
        )}
        {showUndo && (
          <>
            <span aria-hidden>·</span>
            <button
              type="button"
              onClick={() => onUndo?.(turn.id)}
              disabled={undoingId !== null || runActive}
              className="text-inkSoft underline-offset-2 hover:text-ink hover:underline disabled:cursor-default disabled:opacity-60 disabled:no-underline"
              title="Roll back this change. Your AI team pushes a revert commit and the live app rolls back. You'll be asked to confirm."
            >
              {undoingId === turn.id ? "Rolling back…" : "Undo"}
            </button>
          </>
        )}
      </div>

      {}
      {turn.summary && (
        <p className="mt-1.5 text-[12px] leading-[1.5] text-inkSoft">{turn.summary}</p>
      )}

      {}
      {turn.failure_message && (
        <div className="mt-2.5 rounded-lg border border-amber-200/80 bg-amber-50 p-3">
          <p className="flex items-center gap-2 text-[12px] font-semibold text-amber-800">
            <span aria-hidden className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />
            Nothing shipped
          </p>
          <p className="mt-1 text-[12px] leading-[1.55] text-amber-900/90">
            {turn.failure_message}
          </p>
          {showRetry && (
            <button
              type="button"
              onClick={() => onRetry?.(turn.message)}
              className="mt-2.5 rounded-full border border-amber-300 bg-white px-3.5 py-1 text-[12px] font-medium text-amber-900 transition-colors hover:bg-amber-100"
            >
              Try again
            </button>
          )}
        </div>
      )}

      {}
      {Array.isArray(turn.files) && turn.files.length > 0 && (
        <div className="mt-1.5">
          <p className="text-[11px] font-medium text-inkMuted">
            {changedFilesLabel(turn.files.length)}
          </p>
          <ul className="mt-0.5 space-y-0.5">
            {turn.files.map((f, i) => (
              <li
                key={`${f.path}-${i}`}
                className="flex items-baseline gap-2 text-[12px]"
              >
                <span className={`shrink-0 font-medium ${fileActionClass(f.action)}`}>
                  {f.action}
                </span>
                <span className="min-w-0 break-all font-mono text-inkSoft">
                  {f.path}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {}
      <GateResults turn={turn} />

      {}
      <DeployStatus deploy={deploy} />
    </div>
  );
}
