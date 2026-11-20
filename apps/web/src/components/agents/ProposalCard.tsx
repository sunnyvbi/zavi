"use client";

import { useState } from "react";
import { Markdown } from "@/components/workspace/Markdown";
import { adChangeMoney, adMoney, type AdChangeMoney } from "@zavi/shared";
import { isMetaBudgetHandler, parseProposalView, type ChipTone, type ProposalField, type ProposalView } from "./proposalView";
import { perDay } from "./moneyCards";

const CHIP_CLS: Record<ChipTone, string> = {
  good: "bg-[#e7f5ea] text-[#1f7a34] border-[#cfe6cf]",
  bad: "bg-[#fdecea] text-[#c0392b] border-[#f1c0bc]",
  warn: "bg-[#fdf6e3] text-[#8a6d00] border-[#f0e2c0]",
  neutral: "bg-[#f1efe9] text-[#595959] border-[#e5e7eb]",
};

function Chip({ label, tone }: { label: string; tone: ChipTone }) {
  return (
    <span
      className={`whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[11px] font-semibold tabular-nums ${CHIP_CLS[tone]}`}
    >
      {label}
    </span>
  );
}

export function ProposalFields({ fields }: { fields: ProposalField[] }) {
  if (fields.length === 0) return null;
  return (
    <dl className="mt-2 flex flex-col gap-2">
      {fields.map((f, i) => (
        <div key={`${f.label}-${i}`} className="min-w-0">
          <dt className="text-[11px] font-medium text-inkMuted">{f.label}</dt>
          <dd dir="auto" className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md bg-bone px-2 py-1 font-mono text-[12px] leading-snug text-ink">{f.value}</dd>
        </div>
      ))}
    </dl>
  );
}

type IconKind = "pause" | "budget" | "launch" | "generic";

function iconKind(handler: string | null): IconKind {
  return handler?.startsWith("meta_ads.set_status")
    ? "pause"
    : isMetaBudgetHandler(handler)
      ? "budget"
      : handler === "meta_ads.create_ad_set"
        ? "launch"
        : "generic";
}

const FIGMA_ICON: Record<IconKind, { viewBox: string; path: string }> = {
  pause: {
    viewBox: "0 0 22.7446 25.0835",
    path: "M14.4111 1.15088C16.2777 0.25494 17.4034 -0.287144 18.7334 0.159674C20.0795 0.611146 20.5494 1.59832 21.2598 3.09131C23.2396 7.24348 23.2396 12.0075 21.2598 16.1597C20.5482 17.6527 20.0784 18.6398 18.7324 19.0913C18.4058 19.201 18.0915 19.2515 17.7754 19.2515L17.7773 19.2524C16.8068 19.2524 15.8201 18.7786 14.4111 18.1021L8.0752 15.0591C8.71739 17.3122 9.8055 18.3148 10.9131 19.0405C11.6981 19.5551 12.1961 20.3997 12.2451 21.3003C12.2905 22.1331 11.945 22.9166 11.2988 23.4497L9.55957 24.8843C9.3986 25.0172 9.20004 25.0835 9.00293 25.0835C8.81049 25.0835 8.61877 25.02 8.45898 24.894C4.61531 21.8458 4.63281 19.9675 4.6748 15.4282C4.67776 15.085 4.67856 14.7341 4.68066 14.3657C4.58923 14.3828 4.50924 14.3965 4.43066 14.4058C3.28397 14.5363 2.2096 14.2124 1.40234 13.4927C0.51101 12.6982 0 11.4809 0 10.1567V9.09424C1.67958e-06 7.76891 0.511012 6.55281 1.40234 5.75831C2.20845 5.03865 3.28302 4.71462 4.42969 4.84522C4.64785 4.86972 4.87684 4.92126 5.33301 5.02393C5.79025 5.12652 6.2328 5.07612 6.65039 4.87549L14.4111 1.15088ZM6.42188 15.6743C6.3858 19.7086 6.42408 20.9042 9 23.0767L10.1846 22.0991C10.4622 21.8705 10.5076 21.59 10.4971 21.394C10.4783 21.0467 10.2747 20.7145 9.95312 20.5034C8.17082 19.3366 7.0603 17.8413 6.42188 15.6743ZM18.1787 1.81885C17.5535 1.60902 16.9173 1.88932 15.1699 2.72803L7.40918 6.45264C7.27534 6.51692 7.13816 6.57002 7 6.61768V12.6304C7.13812 12.678 7.27423 12.7343 7.4082 12.7983L15.1689 16.5249C16.9166 17.3637 17.5524 17.6431 18.1777 17.4331C18.7925 17.2266 19.0131 16.813 19.6826 15.4087C21.4338 11.7349 21.4338 7.51905 19.6826 3.84522C19.013 2.43956 18.7923 2.02534 18.1787 1.81885ZM4.2334 6.5835C3.57102 6.50779 3.01119 6.66986 2.57031 7.06397C2.05115 7.52714 1.75391 8.26708 1.75391 9.09424V10.1567C1.75391 10.9839 2.05115 11.7239 2.57031 12.187C3.01247 12.5813 3.57155 12.7433 4.23535 12.6675C4.36133 12.6534 4.57113 12.606 4.95312 12.521C5.05177 12.4987 5.15122 12.4815 5.25 12.4673V6.7837C5.15084 6.7694 5.05114 6.75316 4.95215 6.73096C4.57079 6.64583 4.35937 6.5975 4.2334 6.5835Z",
  },
  budget: {
    viewBox: "0 0 25.084 25.0834",
    path: "M12.5411 0C12.5855 0 12.6294 0.00437003 12.672 0.0107422C18.1617 0.217923 23.1342 3.83344 24.6398 9.28223C26.4954 15.9981 22.3639 22.8655 15.4835 24.6533C9.0299 26.3301 2.38304 22.9638 0.0596885 16.9961C-0.0416296 16.7356 -0.0129053 16.4424 0.137813 16.207C0.28883 15.9715 0.544077 15.8222 0.82336 15.8057L3.83215 15.627C4.31455 15.5984 4.72935 15.9668 4.75793 16.4492C4.78637 16.9315 4.41799 17.3454 3.93567 17.374L2.20129 17.4766C4.54355 21.8929 9.84365 24.3113 15.0441 22.96C21.0264 21.4054 24.5354 15.476 22.9532 9.74902C21.6471 5.02175 17.2683 1.85087 12.4073 1.75195C12.3679 1.7525 12.3285 1.75288 12.2892 1.75391C11.8061 1.76651 11.4043 1.38445 11.3917 0.901367C11.3793 0.418465 11.7603 0.0165009 12.2433 0.00390625C12.268 0.00326153 12.2927 0.00243777 12.3175 0.00195312C12.3374 0.000913827 12.3579 0.000665337 12.378 0.000976562C12.3859 0.00109726 12.3937 0.00084203 12.4015 0.000976562C12.448 0.000407892 12.4945 1.63958e-06 12.5411 0ZM12.4327 6.97754C12.916 6.97754 13.3077 7.36932 13.3077 7.85254V8.07129C13.4608 8.10149 13.6188 8.14086 13.7804 8.19043C14.9653 8.55409 15.5551 9.45348 15.6964 10.3652C15.8262 11.2035 15.5888 12.1341 15.0441 12.7041C14.5362 13.2354 13.9781 13.4052 13.4405 13.458C13.2233 13.4794 12.9956 13.4824 12.797 13.4854C12.7751 13.4857 12.7536 13.486 12.7325 13.4863C12.5065 13.49 12.2904 13.4959 12.0587 13.5195C11.5945 13.567 11.3509 13.7042 11.2325 13.8115C11.1218 13.9121 11.0728 14.0271 11.0655 14.1572C11.0493 14.4506 11.2615 14.8976 11.7687 15.127C12.3266 15.3792 12.7176 15.3144 13.004 15.1904C13.3306 15.049 13.5814 14.8036 13.7784 14.5967C14.1117 14.2469 14.6648 14.2333 15.0148 14.5664C15.3647 14.8997 15.3783 15.4538 15.045 15.8037C14.8319 16.0276 14.3747 16.5035 13.6993 16.7959C13.5745 16.8499 13.4437 16.8971 13.3077 16.9355V17.1855C13.3077 17.6688 12.916 18.0605 12.4327 18.0605C11.9496 18.0604 11.5577 17.6687 11.5577 17.1855V16.9121C11.3913 16.8631 11.2208 16.8003 11.047 16.7217C9.96594 16.2327 9.25734 15.1638 9.31848 14.0605C9.34999 13.4926 9.59008 12.9388 10.0577 12.5146C10.5181 12.0973 11.1442 11.8536 11.881 11.7783C12.1922 11.7465 12.472 11.7401 12.7042 11.7363C12.7226 11.736 12.7404 11.7356 12.7579 11.7354C12.9744 11.7319 13.1286 11.7297 13.2696 11.7158C13.5193 11.6912 13.6392 11.6418 13.7794 11.4951C13.8828 11.3869 14.0289 11.0351 13.9669 10.6338C13.9162 10.3061 13.7383 10.008 13.2667 9.86328C12.9863 9.77727 12.7304 9.74317 12.5001 9.74316C12.4779 9.74485 12.4553 9.74512 12.4327 9.74512C12.4229 9.74512 12.4132 9.74544 12.4034 9.74512C11.6827 9.77576 11.2319 10.1413 11.0929 10.2676C10.7354 10.5927 10.1817 10.5665 9.85656 10.209C9.53175 9.85156 9.558 9.29872 9.91516 8.97363C10.1426 8.76676 10.7101 8.31626 11.5577 8.10449V7.85254C11.5578 7.36938 11.9496 6.97764 12.4327 6.97754ZM0.894649 12.5586C1.37772 12.5681 1.76146 12.9671 1.75207 13.4502C1.75038 13.5361 1.75012 13.6227 1.75012 13.709C1.74997 14.192 1.35816 14.5839 0.875118 14.584C0.391958 14.584 0.000262459 14.1921 0.000118154 13.709C0.000118154 13.6112 0.00112918 13.5134 0.00304784 13.416C0.0125706 12.9329 0.411572 12.5492 0.894649 12.5586ZM0.647579 9.38965C0.790067 8.92821 1.27978 8.66946 1.74133 8.81152C2.20295 8.95387 2.46246 9.44364 2.32043 9.90527C2.27009 10.0685 2.22283 10.2342 2.17883 10.4004C2.05505 10.8674 1.57558 11.1451 1.10852 11.0215C0.641559 10.8977 0.362845 10.4192 0.486446 9.95215C0.536473 9.76317 0.590313 9.57536 0.647579 9.38965ZM2.39465 5.69922C2.66212 5.29674 3.20506 5.18663 3.60754 5.4541C4.01002 5.72158 4.11915 6.26549 3.85168 6.66797C3.75741 6.80984 3.666 6.95413 3.57727 7.10059C3.32687 7.5139 2.78843 7.64591 2.37512 7.39551C1.96181 7.14511 1.8298 6.60667 2.0802 6.19336C2.18159 6.02601 2.2868 5.8615 2.39465 5.69922ZM5.15051 2.66602C5.52692 2.36295 6.07791 2.42242 6.38098 2.79883C6.68381 3.17523 6.62449 3.7263 6.24817 4.0293C6.11618 4.13557 5.98609 4.24476 5.85852 4.35742C5.49635 4.67728 4.94308 4.64334 4.62317 4.28125C4.30327 3.91904 4.3381 3.36579 4.70031 3.0459C4.84767 2.91576 4.99772 2.78904 5.15051 2.66602ZM8.74719 0.649414C9.20308 0.489111 9.7031 0.729661 9.8634 1.18555C10.0234 1.64126 9.78388 2.14048 9.32824 2.30078C9.16938 2.35664 9.01138 2.41664 8.85559 2.48047C8.40851 2.66336 7.89811 2.44899 7.71496 2.00195C7.53198 1.55491 7.74556 1.04457 8.1925 0.861328C8.37541 0.786392 8.5603 0.715135 8.74719 0.649414Z",
  },
  launch: { viewBox: "0 0 24 24", path: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm1 5v4h4v2h-4v4h-2v-4H7v-2h4V7h2Z" },
  generic: { viewBox: "0 0 24 24", path: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Z" },
};

function ProposalIcon({
  handler,
  figma = false,
}: {
  handler: string | null;
  figma?: boolean;
}) {
  const kind = iconKind(handler);

  if (figma) {
    const icon = FIGMA_ICON[kind];
    return (
      <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-[#f0f0f0] bg-[#f9f9f9] text-[#1f1f1f]">
        <svg
          aria-hidden
          viewBox={icon.viewBox}
          fill="currentColor"
          className="h-[26px] w-[26px]"
        >
          <path d={icon.path} />
        </svg>
      </span>
    );
  }

  const strokePath: Record<IconKind, React.ReactNode> = {
    pause: <path d="M3 11v2a1 1 0 0 0 1 1h2l4 4V6L6 10H4a1 1 0 0 0-1 1Zm11-4a4 4 0 0 1 0 10" />,
    budget: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v10M9.5 9.5a2.5 2 0 0 1 5 0c0 1.5-5 1-5 3a2.5 2 0 0 0 5 0" />
      </>
    ),
    launch: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v8M8 12h8" />
      </>
    ),
    generic: <circle cx="12" cy="12" r="8" />,
  };
  return (
    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-[#f1efe9] text-[#595959]">
      <svg
        aria-hidden
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-[18px] w-[18px]"
      >
        {strokePath[kind]}
      </svg>
    </span>
  );
}

type SummaryProps = {
  decisionClass: string;
  handler: string | null;
  body: Record<string, unknown>;
  showAction?: boolean;
};

export function ProposalSummary(props: SummaryProps) {
  const money = props.showAction === false ? null : adChangeMoney(props.decisionClass, props.body);
  return money ? <MoneyAdSummary {...props} money={money} /> : <GenericProposalSummary {...props} />;
}

export function reasoningAfterLead(v: Pick<ProposalView, "lead" | "full">): string | null {
  if (!v.full) return null;
  const lead = (v.lead ?? "").replace(/…$/, "").trim();
  const full = v.full.trim();
  if (lead && full.startsWith(lead)) {
    const rest = full.slice(lead.length).trim();
    return rest.length > 0 ? rest : null;
  }
  return full;
}

const PLATFORM: Record<string, string> = { meta_ads: "Meta", google_ads: "Google" };

function MoneyAdSummary({ decisionClass, handler, body, money }: SummaryProps & { money: AdChangeMoney }) {
  const v = parseProposalView(decisionClass, handler, body);
  const [open, setOpen] = useState(false);
  const why = [typeof body.about === "string" && body.about.trim() ? body.about.trim() : null, reasoningAfterLead(v)].filter(Boolean).join("\n\n");
  const d = money.delta;
  const cur = money.currency;
  const chips = v.chips.filter((c) => c.tone === "warn" || c.label === "high-confidence");
  return (
    <>
      <div className="min-w-0">
        <div className="flex items-baseline justify-between gap-3">
          <div className="text-[16px] font-semibold leading-snug text-[#1f1f1f]">
            {money.verb} {money.name}
          </div>
          <span className="shrink-0 text-[11px] text-[#a8a8a8]">{PLATFORM[decisionClass.split(".")[0] ?? ""] ?? ""}</span>
        </div>
        {money.before !== null && money.after !== null && (
          <div data-testid="money-line" className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="text-[22px] font-semibold leading-7 tracking-tight text-[#0e0f11] tabular-nums">
              {perDay(money.before, cur)} <span className="text-[#a8a8a8]">→</span> {perDay(money.after, cur)}
            </span>
            {d === 0 && (money.verb === "Turn on" || money.verb === "Pause") && (
              <span className="whitespace-nowrap rounded-md border border-[#e5e7eb] bg-[#f1efe9] px-1.5 py-0.5 text-[11px] font-semibold text-[#595959]">
                {money.verb === "Turn on" ? "Already on, adds nothing" : "Already paused, saves nothing"}
              </span>
            )}
            {d !== null && d !== 0 && (
              <span
                className={`whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[11px] font-semibold tabular-nums ${
                  d > 0 ? "border-[#f0dca6] bg-[#fdf3dc] text-[#8a5a10]" : "border-[#e5e7eb] bg-[#f1efe9] text-[#595959]"
                }`}
              >
                {d > 0 ? `Spend up ${adMoney(d, cur)}/day` : `Spend down ${adMoney(-d, cur)}/day`}
              </span>
            )}
            {chips.map((c, i) => (
              <Chip key={i} label={c.label} tone={c.tone} />
            ))}
          </div>
        )}
      </div>
      {v.lead && <div className="mt-1.5 text-[13px] leading-snug text-[#3f3f3f] tabular-nums">{v.lead}</div>}
      {why && (
        <>
          <button type="button" onClick={() => setOpen((o) => !o)} className="mt-1 cursor-pointer text-[12px] font-semibold text-[#1f7a34] hover:underline">
            {open ? "Hide why" : "Why this change?"}
          </button>
          {open && <div className="mt-1 whitespace-pre-wrap text-[12px] leading-relaxed text-[#595959]">{why}</div>}
        </>
      )}
    </>
  );
}

function GenericProposalSummary({
  decisionClass,
  handler,
  body,
  showAction = true,
}: SummaryProps) {
  const v: ProposalView = parseProposalView(decisionClass, handler, body);
  const hasDetail = Boolean(v.full || v.markdown);
  const [open, setOpen] = useState(Boolean(v.full) && !v.markdown);

  return (
    <>
      {}
      <div className="flex items-start justify-between gap-3">
        {showAction ? (
          <div className="min-w-0">
            <div className="text-[16px] font-semibold leading-snug text-[#1f1f1f]">
              {v.action}
            </div>
            {v.target && (
              <div className="mt-0.5 truncate text-[11px] text-[#a8a8a8]">
                {v.target}
              </div>
            )}
          </div>
        ) : (
          <span />
        )}
        {v.chips.length > 0 && (
          <div className="flex shrink-0 flex-wrap justify-end gap-1">
            {v.chips.map((c, i) => (
              <Chip key={i} label={c.label} tone={c.tone} />
            ))}
          </div>
        )}
      </div>

      <ProposalFields fields={v.fields} />

      {}
      {v.about && (
        <div className="mt-1 text-[12px] italic leading-snug text-[#8a8a8a]">
          {v.about}
        </div>
      )}

      {}
      {v.lead && (
        <div className="mt-1.5 text-[13px] leading-snug text-[#3f3f3f]">
          {v.lead}
        </div>
      )}

      {}
      {hasDetail && (
        <>
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="mt-1 cursor-pointer text-[12px] font-semibold text-[#1f7a34] hover:underline"
          >
            {open ? "Hide details" : "Why?"}
          </button>
          {open && (
            <div className="mt-1.5">
              {v.full && (
                <div className="whitespace-pre-wrap text-[12px] leading-relaxed text-[#595959]">
                  {v.full}
                </div>
              )}
              {v.markdown && (
                <div className="mt-1 max-h-96 overflow-auto rounded-md text-[12px]">
                  <Markdown source={v.markdown} disableActionLinks />
                </div>
              )}
            </div>
          )}
        </>
      )}
    </>
  );
}

export function ProposalCard({
  decisionClass,
  handler,
  body,
  actions,
  footer,
  className,
  figma = false,
}: {
  decisionClass: string;
  handler: string | null;
  body: Record<string, unknown>;
  actions?: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
  figma?: boolean;
}) {
  if (figma) {
    return (
      <div
        className={
          className ??
          "relative rounded-block border border-[#f0f0f0] bg-white p-6"
        }
      >
        <FigmaProposalBody
          decisionClass={decisionClass}
          handler={handler}
          body={body}
          actions={actions}
        />
        {footer}
      </div>
    );
  }

  return (
    <div
      className={
        className ?? "rounded-xl border border-[#e8e4da] bg-white px-4 py-3.5"
      }
    >
      <div className="flex gap-3">
        <ProposalIcon handler={handler} />
        <div className="min-w-0 flex-1">
          <ProposalSummary
            decisionClass={decisionClass}
            handler={handler}
            body={body}
          />
        </div>
        {actions && (
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 self-start">
            {actions}
          </div>
        )}
      </div>
      {footer}
    </div>
  );
}

const FIGMA_BADGE_CLS: Record<ChipTone, string> = {
  good: "bg-[#f5faf8] text-[#167f50]",
  bad: "bg-[#fef2f3] text-[#cb2029]",
  warn: "bg-[#fdf6e3] text-[#8a6d00]",
  neutral: "bg-[#f0f0f0] text-[#1f1f1f]",
};

function FigmaBadge({ label, tone }: { label: string; tone: ChipTone }) {
  return (
    <span
      className={`whitespace-nowrap rounded-md px-1.5 py-1 text-[13px] font-medium leading-[18px] tabular-nums ${FIGMA_BADGE_CLS[tone]}`}
    >
      {label}
    </span>
  );
}

function FigmaProposalBody({
  decisionClass,
  handler,
  body,
  actions,
}: {
  decisionClass: string;
  handler: string | null;
  body: Record<string, unknown>;
  actions?: React.ReactNode;
}) {
  const v: ProposalView = parseProposalView(decisionClass, handler, body);
  const hasDetail = Boolean(v.full || v.markdown);
  const [open, setOpen] = useState(false);

  return (
    <>
      {}
      {v.chips.length > 0 && (
        <div className="absolute right-6 top-[18px] flex items-center gap-2">
          {v.chips.map((c, i) => (
            <FigmaBadge key={i} label={c.label} tone={c.tone} />
          ))}
        </div>
      )}

      <div className="flex items-stretch gap-[15px]">
        {}
        <ProposalIcon handler={handler} figma />

        {}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="pr-40 text-[20px] font-semibold leading-[25px] text-[#0e0f11]">
            {v.action}
          </div>
          {v.target && (
            <div className="mt-2 truncate text-[12px] font-medium leading-4 text-[#595959]">
              {v.target}
            </div>
          )}
          <ProposalFields fields={v.fields} />
          {v.lead && (
            <div className="mt-[7px] text-[16px] font-medium leading-5 text-[#0e0f11]">
              {v.lead}
              {hasDetail && (
                <>
                  {" "}
                  <button
                    type="button"
                    onClick={() => setOpen((o) => !o)}
                    className="cursor-pointer font-medium text-[#027bff] underline hover:no-underline"
                  >
                    {open ? "Hide" : "Why?"}
                  </button>
                </>
              )}
            </div>
          )}
          {!v.lead && hasDetail && (
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              className="mt-[7px] self-start cursor-pointer text-[16px] font-medium text-[#027bff] underline hover:no-underline"
            >
              {open ? "Hide" : "Why?"}
            </button>
          )}

          {}
          {hasDetail && open && (
            <div className="mt-2">
              {v.full && (
                <div className="whitespace-pre-wrap text-[13px] leading-relaxed text-[#595959]">
                  {v.full}
                </div>
              )}
              {v.markdown && (
                <div className="mt-1 max-h-96 overflow-auto rounded-md text-[13px]">
                  <Markdown source={v.markdown} disableActionLinks />
                </div>
              )}
            </div>
          )}
        </div>

        {}
        {actions && (
          <div className="flex shrink-0 items-end justify-end gap-[15px] self-end">
            {actions}
          </div>
        )}
      </div>
    </>
  );
}
