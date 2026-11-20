"use client";

import { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import type {
  TeamMemberRow,
  TeamMemberIdentitySummary,
  DiscoverResponse,
} from "@/lib/team/types";
import { TeamMemberEditModal } from "./TeamMemberEditModal";
import { PersonAvatar } from "./AgentAvatar";

type EditorState = { mode: "closed" } | { mode: "edit"; member_id: string };
type MergeState = { mode: "off" } | { mode: "picking"; keep_id: string };
type FilterId = "all" | "needs_review" | "people" | "bot";

type Provider = TeamMemberIdentitySummary["provider"];

const PROVIDER_META: Record<Provider, { label: string; logo: string }> = {
  slack: { label: "Slack", logo: "/team/slack.svg" },
  jira: { label: "Jira", logo: "/team/jira.svg" },
  github: { label: "GitHub", logo: "/team/github.svg" },
};

const PROVIDER_ORDER: Provider[] = ["slack", "jira", "github"];

function providerValue(items: TeamMemberIdentitySummary[]): {
  primary: string;
  secondary: string;
} {
  const primary = items
    .map((i) => i.external_display_name ?? i.external_id)
    .join(", ");
  const tail: string[] = [];
  const emails = items.map((i) => i.external_email).filter(Boolean) as string[];
  if (emails.length) tail.push(emails.join(", "));
  const keys = items.flatMap((i) => i.recent_issue_keys ?? []);
  if (keys.length) tail.push(keys.join(", "));
  return { primary, secondary: tail.join(" · ") };
}

export function TeamRosterCard() {
  const [members, setMembers] = useState<TeamMemberRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [discovering, setDiscovering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState>({ mode: "closed" });
  const [merge, setMerge] = useState<MergeState>({ mode: "off" });
  const [filter, setFilter] = useState<FilterId>("all");
  const rail = useRef<HTMLDivElement | null>(null);
  const tabs = useRef<Partial<Record<FilterId, HTMLButtonElement | null>>>({});
  const [pill, setPill] = useState<{ x: number; w: number } | null>(null);

  useEffect(() => {
    const el = rail.current;
    if (!el) return;
    const measure = () => {
      const tab = tabs.current[filter];
      if (!tab || !tab.offsetWidth) return;
      setPill({ x: tab.offsetLeft - el.clientLeft, w: tab.offsetWidth });
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [filter, loading]);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch("/api/team/members");
      if (!res.ok) {
        setError(`team_fetch_failed:${res.status}`);
        return;
      }
      const json = (await res.json()) as { members?: TeamMemberRow[] };
      setMembers(json.members ?? []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function onDiscover() {
    setDiscovering(true);
    setError(null);
    try {
      const res = await apiFetch("/api/team/discover", {
        method: "POST",
        body: JSON.stringify({ providers: ["github", "slack", "jira"] }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        setError(body?.error?.message ?? `discover_failed:${res.status}`);
        return;
      }
      const json = (await res.json()) as DiscoverResponse;
      window.setTimeout(() => void refresh(), 3000);
      if (!json.created) {
        setError("A discovery job is already running. Wait a moment and refresh.");
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDiscovering(false);
    }
  }

  async function onMergeConfirm(dropId: string) {
    if (merge.mode !== "picking") return;
    if (merge.keep_id === dropId) {
      setError("Cannot merge a member with itself.");
      return;
    }
    setError(null);
    try {
      const res = await apiFetch("/api/team/members/merge", {
        method: "POST",
        body: JSON.stringify({ keep_id: merge.keep_id, drop_id: dropId }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        setError(body?.error?.message ?? `merge_failed:${res.status}`);
        return;
      }
      setMerge({ mode: "off" });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const counts = {
    all: members.length,
    needs_review: members.filter((m) => m.ambiguous_count > 0).length,
    people: members.filter((m) => m.kind === "human").length,
    bot: members.filter((m) => m.kind !== "human").length,
  };

  const visibleMembers = members.filter((m) => {
    switch (filter) {
      case "needs_review":
        return m.ambiguous_count > 0;
      case "people":
        return m.kind === "human";
      case "bot":
        return m.kind !== "human";
      default:
        return true;
    }
  });

  if (loading) {
    return <RosterSkeleton />;
  }

  return (
    <div data-testid="team-discovery-surface" className="team-surface-enter flex flex-col gap-5">
      {}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div ref={rail} role="tablist" aria-label="Observed team filters" className="relative inline-flex flex-wrap items-center gap-1 rounded-full border border-rule bg-bone p-1">
          {pill && (
            <span
              aria-hidden="true"
              data-testid="team-filter-pill"
              className="pointer-events-none absolute bottom-1 left-0 top-1 rounded-full bg-cream shadow-[0_1px_3px_rgba(25,25,25,0.10)] transition-[transform,width] duration-300 ease-out motion-reduce:transition-none"
              style={{ width: `${pill.w}px`, transform: `translateX(${pill.x}px)` }}
            />
          )}
          {(
            [
              ["all", "All", counts.all],
              ["needs_review", "Needs review", counts.needs_review],
              ["people", "People", counts.people],
              ["bot", "Bot", counts.bot],
            ] as const
          ).map(([id, label, count]) => (
            <FilterPill
              key={id}
              id={id}
              label={label}
              count={count}
              active={filter}
              measured={pill !== null}
              onSelect={setFilter}
              buttonRef={(el) => {
                tabs.current[id] = el;
              }}
            />
          ))}
        </div>
        <button
          type="button"
          onClick={onDiscover}
          disabled={discovering}
          className="team-secondary-action inline-flex h-10 shrink-0 items-center gap-2 rounded-full border border-rule bg-cream pl-4 pr-5 text-[14px] font-semibold text-ink shadow-sm transition-[background-color,border-color,box-shadow,transform] duration-200 hover:-translate-y-px hover:border-ink/20 hover:bg-bone hover:shadow-md active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <RescanIcon spinning={discovering} />
          {discovering ? "Scanning…" : members.length === 0 ? "Discover team" : "Re-Scan"}
        </button>
      </div>

      {merge.mode === "picking" && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-ink/10 bg-bone px-4 py-2.5 text-[13px] text-ink">
          <span>
            Merge mode: pick the member to merge INTO{" "}
            <strong>{members.find((m) => m.id === merge.keep_id)?.display_name ?? "-"}</strong>. The
            picked member becomes the keep side.
          </span>
          <button
            type="button"
            onClick={() => setMerge({ mode: "off" })}
            className="shrink-0 text-inkMuted hover:text-ink"
          >
            Cancel
          </button>
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-2.5 text-[13px] text-rose-800">
          {error}
        </div>
      )}

      {members.length === 0 ? (
        <div className="rounded-3xl border border-rule bg-cream px-6 py-10 text-center shadow-[0_1px_2px_rgba(14,15,17,0.03)]">
          <div className="mx-auto mb-4 grid size-12 place-items-center rounded-2xl border border-rule bg-bone text-ink"><PeopleIcon /></div>
          <p className="text-[16px] font-semibold text-ink">Bring your team into focus</p>
          <p className="mx-auto mt-1.5 max-w-md text-[14px] leading-6 text-inkMuted">
            No team discovered yet. Connect GitHub, Slack, or Jira, then click{" "}
            <strong className="font-semibold text-ink">Discover team</strong>.
          </p>
          <div className="mt-5 flex items-center justify-center gap-3 opacity-70">
            {PROVIDER_ORDER.map((provider) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={provider}
                src={PROVIDER_META[provider].logo}
                alt={PROVIDER_META[provider].label}
                className={`size-5 object-contain${provider === "github" ? " theme-logo" : ""}`}
              />
            ))}
          </div>
        </div>
      ) : visibleMembers.length === 0 ? (
        <div className="rounded-3xl border border-rule bg-cream px-4 py-10 text-center text-[14px] text-inkMuted">
          No people match this filter.
        </div>
      ) : (
        visibleMembers.map((m) => (
          <MemberCard
            key={m.id}
            member={m}
            mergeState={merge}
            onEdit={() => setEditor({ mode: "edit", member_id: m.id })}
            onStartMerge={() => setMerge({ mode: "picking", keep_id: m.id })}
            onMergeInto={() => void onMergeConfirm(m.id)}
          />
        ))
      )}

      {editor.mode === "edit" && (
        <TeamMemberEditModal
          memberId={editor.member_id}
          onClose={() => setEditor({ mode: "closed" })}
          onSaved={async () => {
            setEditor({ mode: "closed" });
            await refresh();
          }}
        />
      )}
    </div>
  );
}

function FilterPill({
  id,
  label,
  count,
  active,
  measured,
  onSelect,
  buttonRef,
}: {
  id: FilterId;
  label: string;
  count: number;
  active: FilterId;
  measured: boolean;
  onSelect: (id: FilterId) => void;
  buttonRef: (el: HTMLButtonElement | null) => void;
}) {
  const isActive = active === id;
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={() => onSelect(id)}
      role="tab"
      aria-selected={isActive}
      className={`relative z-10 inline-flex h-8 items-center justify-center rounded-full px-4 text-[14px] font-semibold transition-[color,transform] duration-200 active:scale-[0.98] motion-reduce:transition-none ${
        isActive
          ? `text-ink${measured ? "" : " bg-cream shadow-[0_1px_3px_rgba(25,25,25,0.10)]"}`
          : "text-inkMuted hover:text-ink"
      }`}
    >
      {label} {count}
    </button>
  );
}

function RosterSkeleton() {
  return (
    <div className="flex flex-col gap-5" aria-hidden>
      <div className="flex items-center justify-between gap-3">
        <div className="h-9 w-[380px] max-w-[70%] animate-pulse rounded-full bg-bone" />
        <div className="h-10 w-[112px] animate-pulse rounded-xl bg-bone" />
      </div>
      {[0, 1].map((i) => (
        <div
          key={i}
          className="flex flex-col gap-[18px] rounded-3xl border border-rule bg-cream px-4 py-4"
        >
          <div className="flex items-start justify-between gap-6">
            <div className="flex min-w-0 flex-1 flex-col gap-[15px]">
              <div className="flex items-center gap-[11px]">
                <div className="h-9 w-9 shrink-0 animate-pulse rounded-full bg-[#f0f0f0]" />
                <div className="h-[18px] w-32 animate-pulse rounded bg-[#f0f0f0]" />
                <div className="h-[22px] w-16 animate-pulse rounded-[6px] bg-[#f0f0f0]" />
              </div>
              <div className="flex flex-col gap-2">
                <div className="h-3.5 w-64 max-w-full animate-pulse rounded bg-[#f0f0f0]" />
                <div className="h-3.5 w-52 max-w-full animate-pulse rounded bg-[#f0f0f0]" />
              </div>
            </div>
            <div className="flex shrink-0 gap-4">
              <div className="h-10 w-16 animate-pulse rounded-[12px] bg-[#f0f0f0]" />
              <div className="h-10 w-20 animate-pulse rounded-[12px] bg-[#f0f0f0]" />
            </div>
          </div>
          <div className="h-[18px] w-36 animate-pulse rounded bg-[#f0f0f0]" />
        </div>
      ))}
    </div>
  );
}

function MemberCard({
  member,
  mergeState,
  onEdit,
  onStartMerge,
  onMergeInto,
}: {
  member: TeamMemberRow;
  mergeState: MergeState;
  onEdit: () => void;
  onStartMerge: () => void;
  onMergeInto: () => void;
}) {
  const [showIds, setShowIds] = useState(false);

  const grouped = PROVIDER_ORDER.map((p) => ({
    provider: p,
    items: member.identities.filter((i) => i.provider === p),
  })).filter((g) => g.items.length > 0);

  const isPicking = mergeState.mode === "picking";
  const isKeep = isPicking && mergeState.keep_id === member.id;

  const photoUrl =
    PROVIDER_ORDER.map(
      (p) => member.identities.find((i) => i.provider === p && i.avatar_url)?.avatar_url,
    ).find(Boolean) ?? null;

  return (
    <div
      className={`team-card-enter flex flex-col gap-[18px] rounded-3xl border bg-cream px-4 py-4 transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-px hover:shadow-[0_10px_32px_rgba(14,15,17,0.06)] ${
        isKeep ? "border-ink/40 ring-1 ring-ink/20" : "border-rule"
      }`}
    >
      {}
      <div className="flex items-start justify-between gap-6">
        <div className="flex min-w-0 flex-col gap-[15px]">
          <div className="flex items-center gap-[13px]">
            <div className="flex min-w-0 items-center gap-[11px]">
              {}
              <PersonAvatar seed={member.id} photoUrl={photoUrl} size="lg" />
              <span className="truncate text-[16px] font-semibold leading-[24px] text-ink">
                {member.display_name}
              </span>
            </div>
            <KindChip kind={member.kind} />
            {member.ambiguous_count > 0 && (
              <span className="rounded-[6px] bg-amber-50 px-1.5 py-1 text-[12px] font-medium text-amber-700">
                Ambiguous
              </span>
            )}
          </div>

          {}
          {grouped.length > 0 && (
            <div className="flex flex-col gap-2">
              {grouped.map((g) => {
                const { primary, secondary } = providerValue(g.items);
                return (
                  <div key={g.provider} className="flex items-baseline">
                    <span className="w-[52px] shrink-0 text-[16px] font-semibold leading-[20px] text-[#0e0f11]">
                      {PROVIDER_META[g.provider].label}
                    </span>
                    <span className="min-w-0 text-[16px] leading-[20px]">
                      <span className="font-medium text-[#0e0f11]">
                        {primary}
                        {secondary ? " · " : ""}
                      </span>
                      {secondary && (
                        <span className="font-normal text-[#595959]">{secondary}</span>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {}
        <div className="flex shrink-0 items-center gap-4">
          {isPicking ? (
            isKeep ? (
              <span className="inline-flex h-10 items-center rounded-[12px] border border-[#f0f0f0] bg-bone px-4 text-[16px] font-semibold text-inkMuted">
                keep
              </span>
            ) : (
              <button
                type="button"
                onClick={onMergeInto}
                className="inline-flex h-10 items-center rounded-cta border border-ink/25 bg-cream px-4 text-[14px] font-semibold text-ink transition-colors hover:border-ink/40 hover:bg-bone"
              >
                Merge into keep
              </button>
            )
          ) : (
            <>
              <ActionButton label="Edit" onClick={onEdit} />
              <ActionButton label="Merge" onClick={onStartMerge} />
            </>
          )}
        </div>
      </div>

      {}
      {member.identities.length > 0 && (
        <div className="flex flex-col gap-[18px]">
          <button
            type="button"
            onClick={() => setShowIds((v) => !v)}
            className="inline-flex items-center gap-2.5 self-start rounded-cta px-1 py-1 text-[13px] font-medium leading-[18px] text-ink transition-colors hover:bg-bone"
          >
            <ExpandIcon />
            {showIds ? "Hide account IDs" : "Show account IDs"}
          </button>
          {showIds && (
            <div className="flex flex-wrap gap-[18px]">
              {member.identities.map((i) => (
                <IdentityChip
                  key={`${i.provider}-${i.external_id}`}
                  provider={i.provider}
                  externalId={i.external_id}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ActionButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-10 items-center justify-center rounded-cta border border-rule bg-cream px-4 text-[14px] font-semibold text-ink transition-[background-color,border-color,transform] duration-200 hover:-translate-y-px hover:border-ink/20 hover:bg-bone active:translate-y-0"
    >
      {label}
    </button>
  );
}

function IdentityChip({
  provider,
  externalId,
}: {
  provider: Provider;
  externalId: string;
}) {
  const [copied, setCopied] = useState(false);
  const [logoFailed, setLogoFailed] = useState(false);
  const meta = PROVIDER_META[provider];

  async function copy() {
    try {
      await navigator.clipboard.writeText(externalId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
    }
  }

  return (
    <div className="flex w-[263px] max-w-full items-center gap-2 rounded-[12px] bg-[#f9f9f9] px-4 py-3">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="flex shrink-0 items-center gap-2">
          {logoFailed ? (
            <span className="grid h-5 w-5 shrink-0 place-items-center rounded bg-white text-[9px] font-bold text-inkMuted">
              {meta.label.slice(0, 1)}
            </span>
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={meta.logo}
              alt=""
              className="h-5 w-5 shrink-0 object-contain"
              onError={() => setLogoFailed(true)}
            />
          )}
          <span className="text-[16px] font-semibold leading-[20px] text-[#0e0f11]">
            {meta.label}:
          </span>
        </span>
        <span className="min-w-0 flex-1 truncate text-[16px] font-medium leading-[20px] text-[#0e0f11]">
          {externalId}
        </span>
      </div>
      <button
        type="button"
        onClick={copy}
        aria-label={`Copy ${meta.label} id`}
        className="shrink-0 text-inkMuted transition-colors hover:text-[#0e0f11]"
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
    </div>
  );
}

function KindChip({ kind }: { kind: "human" | "bot" | "service_account" }) {
  const cfg: Record<typeof kind, { label: string; cls: string }> = {
    human: { label: "Human", cls: "bg-[#f5faf8] text-[#167f50]" },
    bot: { label: "Bot", cls: "bg-bone text-inkMuted" },
    service_account: { label: "Service", cls: "bg-bone text-inkMuted" },
  };
  const c = cfg[kind];
  return (
    <span className={`rounded-[6px] px-1.5 py-1 text-[12px] font-medium leading-[16px] ${c.cls}`}>
      {c.label}
    </span>
  );
}

function RescanIcon({ spinning }: { spinning: boolean }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`h-5 w-5 ${spinning ? "animate-spin" : ""}`}
    >
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </svg>
  );
}

function PeopleIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="size-6">
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

function ExpandIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      fill="currentColor"
      className="h-4 w-4 text-[#0e0f11]"
    >
      <path d="M8.97949 8.97949C9.17465 8.78434 9.49124 8.78456 9.68652 8.97949L13.5 12.793V10.667C13.5 10.3909 13.7239 10.167 14 10.167C14.2761 10.167 14.5 10.3909 14.5 10.667V14C14.5 14.128 14.4511 14.2559 14.3535 14.3535C14.2884 14.4187 14.2091 14.4598 14.126 14.4814C14.1165 14.4839 14.1074 14.4883 14.0977 14.4902C14.0654 14.4966 14.0327 14.5 14 14.5H10.667C10.3909 14.5 10.167 14.2761 10.167 14C10.167 13.7239 10.3909 13.5 10.667 13.5H12.793L8.97949 9.68652C8.78456 9.49124 8.78434 9.17465 8.97949 8.97949ZM5.33301 1.5C5.60915 1.5 5.83301 1.72386 5.83301 2C5.83301 2.27614 5.60915 2.5 5.33301 2.5H3.20703L7.02051 6.31348C7.21544 6.50877 7.21566 6.82535 7.02051 7.02051C6.82535 7.21566 6.50877 7.21544 6.31348 7.02051L2.5 3.20703V5.33301C2.5 5.60915 2.27614 5.83301 2 5.83301C1.72386 5.83301 1.5 5.60915 1.5 5.33301V2C1.5 1.87204 1.54885 1.74412 1.64648 1.64648C1.71164 1.58133 1.79087 1.54023 1.87402 1.51855C1.88355 1.51607 1.89261 1.51169 1.90234 1.50977C1.93457 1.50338 1.96727 1.5 2 1.5H5.33301Z" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 20 20"
      fill="currentColor"
      className="h-5 w-5"
    >
      <path d="M7.95606 1.04199C9.29127 1.04198 10.3497 1.04171 11.1865 1.14063C12.0456 1.24219 12.753 1.45562 13.3438 1.94043C13.5441 2.10486 13.7282 2.28892 13.8926 2.48926C14.3518 3.04902 14.5671 3.71336 14.6748 4.5127C14.7623 5.16194 14.7828 5.94367 14.7881 6.88477C15.3068 6.89561 15.7627 6.91838 16.1592 6.97168C16.9091 7.07253 17.5405 7.28863 18.042 7.79004C18.5436 8.29164 18.7595 8.92374 18.8604 9.67383C18.9574 10.3962 18.957 11.3147 18.957 12.4541V13.3789C18.957 14.5186 18.9575 15.4377 18.8604 16.1602C18.7595 16.9101 18.5435 17.5414 18.042 18.043C17.5405 18.5445 16.9091 18.7605 16.1592 18.8613C15.4367 18.9585 14.5176 18.958 13.3779 18.958H12.4531C11.3137 18.958 10.3952 18.9584 9.67285 18.8613C8.92276 18.7605 8.29066 18.5446 7.78906 18.043C7.28765 17.5415 7.07156 16.91 6.9707 16.1602C6.9174 15.7637 6.89464 15.3078 6.88379 14.7891C5.94269 14.7838 5.16097 14.7633 4.51172 14.6758C3.71238 14.568 3.04804 14.3528 2.48828 13.8936C2.28795 13.7291 2.10388 13.545 1.93945 13.3447C1.45465 12.754 1.24121 12.0465 1.13965 11.1875C1.04073 10.3507 1.04101 9.29225 1.04102 7.95703V7.87598C1.04101 6.54098 1.04078 5.48327 1.13965 4.64648C1.2412 3.7874 1.45467 3.08003 1.93945 2.48926C2.10394 2.28883 2.28785 2.10492 2.48828 1.94043C3.07905 1.45564 3.78642 1.24217 4.64551 1.14063C5.48229 1.04176 6.54001 1.04198 7.875 1.04199H7.95606ZM12.499 8.125C11.3028 8.125 10.4683 8.12631 9.83887 8.21094C9.22755 8.29316 8.90346 8.44322 8.67285 8.67383C8.44225 8.90443 8.29218 9.22853 8.20996 9.83984C8.12533 10.4693 8.12402 11.3038 8.12402 12.5V13.333C8.12402 14.5291 8.12534 15.3637 8.20996 15.9932C8.29215 16.6045 8.44231 16.9286 8.67285 17.1592C8.90345 17.3898 9.22758 17.5399 9.83887 17.6221C10.4683 17.7067 11.3028 17.708 12.499 17.708H13.332C14.5282 17.708 15.3627 17.7067 15.9922 17.6221C16.6037 17.5399 16.9276 17.3898 17.1582 17.1592C17.3888 16.9285 17.5389 16.6046 17.6211 15.9932C17.7057 15.3637 17.707 14.5292 17.707 13.333V12.5C17.707 11.3038 17.7057 10.4693 17.6211 9.83984C17.5389 9.22855 17.3888 8.90443 17.1582 8.67383C16.9276 8.44329 16.6035 8.29313 15.9922 8.21094C15.3627 8.12632 14.5282 8.125 13.332 8.125H12.499ZM7.91602 2.29199C6.53105 2.29199 5.54689 2.29262 4.79199 2.38184C4.05109 2.46941 3.61238 2.63462 3.28125 2.90625C3.14412 3.01879 3.01782 3.14509 2.90527 3.28223C2.63364 3.61336 2.46844 4.05207 2.38086 4.79297C2.29165 5.54787 2.29102 6.53202 2.29102 7.91699C2.29102 9.30191 2.29163 10.2861 2.38086 11.041C2.46848 11.7819 2.63354 12.2207 2.90527 12.5518C3.0178 12.6889 3.14414 12.8142 3.28125 12.9268C3.59531 13.1844 4.00571 13.3468 4.67871 13.4375C5.24461 13.5138 5.94888 13.5335 6.87402 13.5391V12.4541C6.87401 11.3147 6.87362 10.3962 6.9707 9.67383C7.07155 8.92374 7.28747 8.29164 7.78906 7.79004C8.29066 7.28844 8.92276 7.07253 9.67285 6.97168C10.3952 6.8746 11.3137 6.87498 12.4531 6.875H13.5381C13.5326 5.94985 13.5128 5.24559 13.4365 4.67969C13.3458 4.00669 13.1835 3.59629 12.9258 3.28223C12.8133 3.14512 12.6879 3.01878 12.5508 2.90625C12.2197 2.63452 11.7809 2.46945 11.04 2.38184C10.2852 2.29261 9.30094 2.29199 7.91602 2.29199Z" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-[18px] w-[18px] text-emerald-600"
    >
      <path d="m5 12 5 5 9-11" />
    </svg>
  );
}
