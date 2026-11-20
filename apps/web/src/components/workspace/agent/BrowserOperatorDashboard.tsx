"use client";

import {
  useAgentDashboard,
  DashboardShell,
  EmptyState,
} from "./dashboard-ui";

type Payload = {
  generic?: boolean;
};

const INK = "#0e0f11";
const MUTED = "#595959";

function EvidencePreview() {
  const surfaces: Array<{ label: string; detail: string }> = [
    {
      label: "Screenshot evidence",
      detail:
        "Frames captured along the nav → read → fill → click path, proof the action landed on the real page, not a look-alike.",
    },
    {
      label: "Audit log · inline writes",
      detail:
        "Every auto-executed click and fill, in order, each carrying the security audit's safe / flagged verdict. Secrets redacted.",
    },
    {
      label: "Security warnings",
      detail:
        "Off-origin links refused, prompt-injection text surfaced-not-acted-on, destructive controls declined as out-of-scope.",
    },
  ];
  return (
    <section aria-label="What this panel will show once a run completes">
      <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-[#595959]">
        Evidence this operator returns
      </h3>
      <div className="flex flex-col gap-2">
        {surfaces.map((s) => (
          <div
            key={s.label}
            className="rounded-xl border border-dashed border-[#e6e6e6] bg-white px-4 py-3"
          >
            <div className="flex items-center gap-2">
              {}
              <span className="inline-block rounded-full bg-[#f1f0ec] px-2 py-0.5 text-[11px] font-medium text-[#595959]">
                Pending
              </span>
              <span
                className="text-[13px] font-semibold"
                style={{ color: INK }}
              >
                {s.label}
              </span>
            </div>
            <p className="mt-1 text-[12px]" style={{ color: MUTED }}>
              {s.detail}
            </p>
          </div>
        ))}
      </div>
      {}
    </section>
  );
}

const placeholder = (
  <EmptyState title="Your hands on the web">
    Browser Operator drives a real cloud browser. It navigates sites, reads what’s
    on the page, fills forms, and clicks through flows, then reports back with
    evidence. Give it a task in the chat on the right (“go to this page and tell
    me what the pricing says”, “fill out this form on our staging site”), and each
    run’s screenshots + audit log will show up in the Run tab.
  </EmptyState>
);

export function BrowserOperatorDashboard() {
  const state = useAgentDashboard<Payload>("browser-operator");

  return (
    <DashboardShell
      title="Browser Operator"
      subtitle="Your hands on the web. Drives a real cloud browser to navigate, read, and fill forms on the sites you send it to, and reports back with evidence."
      state={state}
      genericFallback={
        <div className="flex flex-col gap-5">
          {placeholder}
          <EvidencePreview />
        </div>
      }
      render={() => (
        <div className="flex flex-col gap-5">
          {placeholder}
          <EvidencePreview />
        </div>
      )}
    />
  );
}
