"use client";

import { useWorkspace } from "../WorkspaceShell";

export type PausedRunStepStatus = "done" | "paused" | "pending";

export type PausedRunStep = {
  label: string;
  status: PausedRunStepStatus;
  creditsNeeded?: number | null;
};

export type PausedOutOfCreditsEnvelope = {
  envelope_kind: "paused_out_of_credits";
  agent_name?: string | null;
  paused_step?: number | null;
  total_steps?: number | null;
  steps?: PausedRunStep[];
};

const STEP_STATUSES: readonly PausedRunStepStatus[] = ["done", "paused", "pending"];

export function parsePausedEnvelope(raw: unknown): {
  agentName: string | null;
  pausedStep: number | null;
  totalSteps: number;
  steps: PausedRunStep[];
} | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.envelope_kind !== "paused_out_of_credits") return null;
  const steps: PausedRunStep[] = Array.isArray(o.steps)
    ? o.steps
        .map((s): PausedRunStep | null => {
          if (!s || typeof s !== "object") return null;
          const so = s as Record<string, unknown>;
          if (typeof so.label !== "string" || !so.label.trim()) return null;
          const status = STEP_STATUSES.includes(so.status as PausedRunStepStatus)
            ? (so.status as PausedRunStepStatus)
            : "pending";
          const creditsNeeded =
            typeof so.creditsNeeded === "number" && Number.isFinite(so.creditsNeeded)
              ? so.creditsNeeded
              : null;
          return { label: so.label, status, creditsNeeded };
        })
        .filter((s): s is PausedRunStep => s !== null)
    : [];
  if (steps.length === 0) return null;
  const totalSteps =
    typeof o.total_steps === "number" && Number.isFinite(o.total_steps) && o.total_steps > 0
      ? Math.floor(o.total_steps)
      : steps.length;
  const pausedStep =
    typeof o.paused_step === "number" && Number.isFinite(o.paused_step) && o.paused_step > 0
      ? Math.floor(o.paused_step)
      : steps.findIndex((s) => s.status === "paused") + 1 || null;
  return {
    agentName: typeof o.agent_name === "string" && o.agent_name.trim() ? o.agent_name : null,
    pausedStep,
    totalSteps,
    steps,
  };
}

function fmtCredits(n: number): string {
  return Math.max(0, Math.floor(n)).toLocaleString("en-US");
}

export function PausedOutOfCreditsCard({
  envelope,
  fallbackAgentName,
}: {
  envelope: unknown;
  fallbackAgentName?: string;
}) {
  const { openTab } = useWorkspace();
  const parsed = parsePausedEnvelope(envelope);
  if (!parsed) return null;
  const { agentName, pausedStep, totalSteps, steps } = parsed;
  const who = agentName ?? fallbackAgentName ?? "your agent";

  function goUpgrade() {
    openTab({
      kind: "settings",
      title: "Settings",
      payload: { kind: "settings" },
      dirty: false,
      pinned: false,
    });
    if (typeof window !== "undefined") {
      window.setTimeout(() => {
        window.location.hash = "billing";
      }, 80);
    }
  }

  return (
    <div className="mt-1 flex w-full flex-col gap-5 rounded-[16px] border border-[#f0f0f0] bg-white p-4 font-sans shadow-[0px_1px_2px_rgba(14,15,17,0.05)]">
      {}
      <div className="flex w-full items-start gap-3">
        <PauseGlyph />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="text-[14px] font-semibold leading-[22px] tracking-[0.15px] text-[#0e0f11]">
            {pausedStep
              ? `Paused: out of credits at step ${pausedStep} of ${totalSteps}`
              : "Paused: out of credits"}
          </p>
          <p className="text-[13px] leading-5 tracking-[0.01px] text-[#595959]">
            Your work is saved. Add credits and {who} resumes from exactly here, without re-running the
            finished steps.
          </p>
        </div>
      </div>

      {}
      <div className="flex w-full flex-col gap-3">
        {steps.map((step, i) => (
          <div key={`${i}-${step.label}`} className="flex w-full items-center gap-3">
            <StepBadge status={step.status} />
            <div className="flex min-w-0 flex-1 items-start gap-1 text-[16px] leading-5 tracking-[0.14px]">
              <span
                className={`min-w-0 flex-1 ${
                  step.status === "paused"
                    ? "font-semibold text-[#0e0f11]"
                    : step.status === "done"
                      ? "font-medium text-[#0e0f11]"
                      : "font-medium text-[#595959]"
                }`}
              >
                {step.label}
              </span>
              {step.status === "paused" && typeof step.creditsNeeded === "number" && (
                <span className="shrink-0 whitespace-nowrap font-medium text-[#946300]">
                  needs ~{fmtCredits(step.creditsNeeded)}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>

      {}
      <button
        type="button"
        onClick={goUpgrade}
        className="flex h-10 items-center justify-center gap-2 self-start rounded-cta bg-[#0e0f11] py-1.5 pl-4 pr-5 text-[16px] font-semibold leading-5 tracking-[0.01px] text-white transition-colors hover:bg-black"
      >
        <ZapGlyph />
        Buy Credits &amp; Resume
      </button>
    </div>
  );
}

function PauseGlyph() {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      className="shrink-0"
    >
      <path
        d="M7.04981 3.25C7.71449 3.24996 8.28745 3.24986 8.7461 3.31153C9.23765 3.37764 9.70864 3.527 10.0908 3.90918C10.473 4.29137 10.6224 4.76236 10.6885 5.25391C10.7501 5.71255 10.75 6.28552 10.75 6.9502V17.0498C10.75 17.7145 10.7501 18.2874 10.6885 18.7461C10.6224 19.2376 10.473 19.7086 10.0908 20.0908C9.70864 20.473 9.23765 20.6224 8.7461 20.6885C8.28745 20.7501 7.71449 20.75 7.04981 20.75H6.9502C6.28552 20.75 5.71255 20.7501 5.25391 20.6885C4.76236 20.6224 4.29137 20.473 3.90918 20.0908C3.527 19.7086 3.37764 19.2376 3.31153 18.7461C3.24986 18.2874 3.24996 17.7145 3.25 17.0498V6.9502C3.24996 6.28552 3.24986 5.71255 3.31153 5.25391C3.37764 4.76236 3.527 4.29137 3.90918 3.90918C4.29137 3.527 4.76236 3.37764 5.25391 3.31153C5.71255 3.24986 6.28552 3.24996 6.9502 3.25H7.04981ZM17.0498 3.25C17.7145 3.24996 18.2874 3.24986 18.7461 3.31153C19.2376 3.37764 19.7086 3.527 20.0908 3.90918C20.473 4.29137 20.6224 4.76236 20.6885 5.25391C20.7501 5.71255 20.75 6.28552 20.75 6.9502V17.0498C20.75 17.7145 20.7501 18.2874 20.6885 18.7461C20.6224 19.2376 20.473 19.7086 20.0908 20.0908C19.7086 20.473 19.2376 20.6224 18.7461 20.6885C18.2874 20.7501 17.7145 20.75 17.0498 20.75H16.9502C16.2855 20.75 15.7126 20.7501 15.2539 20.6885C14.7624 20.6224 14.2914 20.473 13.9092 20.0908C13.527 19.7086 13.3776 19.2376 13.3115 18.7461C13.2499 18.2874 13.25 17.7145 13.25 17.0498V6.9502C13.25 6.28552 13.2499 5.71255 13.3115 5.25391C13.3776 4.76236 13.527 4.29137 13.9092 3.90918C14.2914 3.527 14.7624 3.37764 15.2539 3.31153C15.7126 3.24986 16.2855 3.24996 16.9502 3.25H17.0498ZM7 4.75C6.27178 4.75 5.80097 4.75123 5.4541 4.79785C5.1288 4.84159 5.02682 4.91264 4.96973 4.96973C4.91264 5.02682 4.84159 5.1288 4.79785 5.4541C4.75123 5.80097 4.75 6.27178 4.75 7V17C4.75 17.7282 4.75123 18.199 4.79785 18.5459C4.84159 18.8712 4.91264 18.9732 4.96973 19.0303C5.02682 19.0874 5.1288 19.1584 5.4541 19.2022C5.80097 19.2488 6.27178 19.25 7 19.25C7.72822 19.25 8.19903 19.2488 8.5459 19.2022C8.8712 19.1584 8.97318 19.0874 9.03028 19.0303C9.08737 18.9732 9.15841 18.8712 9.20215 18.5459C9.24877 18.199 9.25 17.7282 9.25 17V7C9.25 6.27178 9.24877 5.80097 9.20215 5.4541C9.15841 5.1288 9.08737 5.02682 9.03028 4.96973C8.97318 4.91264 8.8712 4.84159 8.5459 4.79785C8.19903 4.75123 7.72822 4.75 7 4.75ZM17 4.75C16.2718 4.75 15.801 4.75123 15.4541 4.79785C15.1288 4.84159 15.0268 4.91264 14.9697 4.96973C14.9126 5.02682 14.8416 5.1288 14.7979 5.4541C14.7512 5.80097 14.75 6.27178 14.75 7V17C14.75 17.7282 14.7512 18.199 14.7979 18.5459C14.8416 18.8712 14.9126 18.9732 14.9697 19.0303C15.0268 19.0874 15.1288 19.1584 15.4541 19.2022C15.801 19.2488 16.2718 19.25 17 19.25C17.7282 19.25 18.199 19.2488 18.5459 19.2022C18.8712 19.1584 18.9732 19.0874 19.0303 19.0303C19.0874 18.9732 19.1584 18.8712 19.2022 18.5459C19.2488 18.199 19.25 17.7282 19.25 17V7C19.25 6.27178 19.2488 5.80097 19.2022 5.4541C19.1584 5.1288 19.0874 5.02682 19.0303 4.96973C18.9732 4.91264 18.8712 4.84159 18.5459 4.79785C18.199 4.75123 17.7282 4.75 17 4.75Z"
        fill="#cb2029"
      />
    </svg>
  );
}

function StepBadge({ status }: { status: PausedRunStepStatus }) {
  if (status === "done") {
    return (
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-[#167f50]">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
          <path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M13.7845 3.51117C14.0559 3.75997 14.0742 4.18168 13.8254 4.45309L6.49209 12.4531C6.36922 12.5871 6.19693 12.6652 6.01513 12.6691C5.83334 12.6731 5.65782 12.6026 5.52925 12.474L2.52925 9.47401C2.2689 9.21366 2.2689 8.79155 2.52925 8.5312C2.7896 8.27085 3.21171 8.27085 3.47206 8.5312L5.97971 11.0389L12.8425 3.55213C13.0913 3.28071 13.5131 3.26238 13.7845 3.51117Z"
            fill="#ffffff"
          />
        </svg>
      </span>
    );
  }
  if (status === "paused") {
    return (
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-[#946300]">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
          <path
            d="M6.00098 2.16406C6.6452 2.16406 7.16779 2.6859 7.16797 3.33008V12.6641C7.16779 13.3082 6.6452 13.8301 6.00098 13.8301H3.33398C2.68991 13.8299 2.16814 13.3081 2.16797 12.6641V3.33008C2.16814 2.686 2.68991 2.16424 3.33398 2.16406H6.00098ZM12.668 2.16406C13.312 2.16424 13.8338 2.686 13.834 3.33008V12.6641C13.8338 13.3081 13.312 13.8299 12.668 13.8301H10.001C9.35675 13.8301 8.83416 13.3082 8.83398 12.6641V3.33008C8.83416 2.6859 9.35675 2.16406 10.001 2.16406H12.668Z"
            fill="#ffffff"
          />
        </svg>
      </span>
    );
  }
  return <span className="size-6 shrink-0 rounded-full border-[1.5px] border-[#f0f0f0]" />;
}

function ZapGlyph() {
  return (
    <svg width="18" height="20" viewBox="0 0 10.5 12.0004" fill="none" aria-hidden className="shrink-0">
      <path
        d="M8.18906 1.04552C8.32734 0.724431 8.22422 0.349431 7.94062 0.143181C7.65703 -0.0630692 7.27031 -0.0443192 7.00547 0.185368L1.00547 5.43537C0.771094 5.64162 0.686719 5.97209 0.796875 6.26271C0.907031 6.55334 1.18828 6.75021 1.5 6.75021H4.11328L2.31094 10.9549C2.17266 11.276 2.27578 11.651 2.55937 11.8572C2.84297 12.0635 3.22969 12.0447 3.49453 11.8151L9.49453 6.56506C9.72891 6.35881 9.81328 6.02834 9.70312 5.73771C9.59297 5.44709 9.31406 5.25256 9 5.25256H6.38672L8.18906 1.04552Z"
        fill="white"
      />
    </svg>
  );
}
