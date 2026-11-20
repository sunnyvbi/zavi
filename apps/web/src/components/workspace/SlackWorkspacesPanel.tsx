"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { apiFetch } from "@/lib/api";
import { startConnectFlow, ConnectButton } from "@/app/connectors/ConnectButton";
import { Banner, ConnectorLockup, TileButton, TileState } from "./settings/ConnectorTile";
import { purposeFor } from "./settings/connectorCopy";

const PURPOSES = ["support", "dev", "exec", "general"] as const;
type Purpose = (typeof PURPOSES)[number];

const SLACK_ERROR_COPY: Record<string, string> = {
  invalid_state:
    "Your Slack connection link expired. Please click “+ Add Slack workspace” and try again.",
  state_consume_failed:
    "We couldn’t verify your Slack connection. Please try connecting again.",
  missing_code: "Slack didn’t finish the connection. Please try again.",
  missing_state: "Slack didn’t finish the connection. Please try again.",
  save_failed: "We couldn’t save your Slack connection. Please try again.",
  exchange_failed:
    "We couldn’t reach Slack to finish connecting. Please try again in a moment.",
};

function slackErrorMessage(code: string | null | undefined): string | null {
  if (!code) return null;
  return SLACK_ERROR_COPY[code] ?? "Slack connection failed. Please try again.";
}

type Workspace = {
  team_id: string;
  team_name: string;
  label: string;
  purpose: string;
  suggested_purpose?: Purpose;
  default_agent_slug: string | null;
  missing: string[];
  is_primary: boolean;
  connected_at: string | null;
  team_icon_url?: string | null;
};

type ScopeStatus = {
  connected: boolean;
  workspaces?: Workspace[];
};

type AgentRow = {
  slug: string;
  effective_state: "visible" | "hidden";
};

export function SlackWorkspacesPanel({
  embedded = false,
  asCard = false,
  connected,
  readOnly = false,
  highlighted = false,
}: {
  embedded?: boolean;
  asCard?: boolean;
  connected?: boolean;
  readOnly?: boolean;
  highlighted?: boolean;
} = {}) {
  const searchParams = useSearchParams();
  const justConnectedTeam =
    searchParams.get("slack") === "connected"
      ? searchParams.get("team") ?? undefined
      : undefined;
  const slackErrorCode = searchParams.get("slack_error");

  const [connectError, setConnectError] = useState<string | null>(null);
  const [oauthErrorDismissed, setOAuthErrorDismissed] = useState(false);
  const oauthError =
    connectError ?? (oauthErrorDismissed ? null : slackErrorMessage(slackErrorCode));

  const beginConnect = useCallback(() => {
    setConnectError(null);
    setOAuthErrorDismissed(true);
    void startConnectFlow("slack").catch((e) => {
      setConnectError(
        (e as Error).message || "Couldn’t start the Slack connection. Please try again.",
      );
    });
  }, []);

  const oauthErrorBanner = oauthError ? (
    <Banner
      tone="error"
      title="Couldn’t connect Slack"
      onDismiss={() => {
        setConnectError(null);
        setOAuthErrorDismissed(true);
      }}
    >
      {oauthError}
    </Banner>
  ) : null;

  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [scopeConnected, setScopeConnected] = useState<boolean | null>(null);
  const [agentSlugs, setAgentSlugs] = useState<string[]>([]);
  const [openTeam, setOpenTeam] = useState<string | undefined>(justConnectedTeam);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<boolean>(
    !!justConnectedTeam || highlighted,
  );
  useEffect(() => {
    if (justConnectedTeam || highlighted) setExpanded(true);
  }, [justConnectedTeam, highlighted]);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch("/api/connectors/slack/scope-status");
      if (!res.ok) {
        setLoading(false);
        return;
      }
      const json = (await res.json()) as ScopeStatus;
      setScopeConnected(json.connected);
      setWorkspaces(json.connected ? json.workspaces ?? [] : []);
    } catch {
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch("/api/agents/visibility");
        if (!res.ok) return;
        const json = (await res.json()) as { agents?: AgentRow[] };
        if (cancelled) return;
        setAgentSlugs(
          (json.agents ?? [])
            .filter((a) => a.effective_state === "visible")
            .map((a) => a.slug)
            .sort(),
        );
      } catch {
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (justConnectedTeam && workspaces?.some((w) => w.team_id === justConnectedTeam)) {
      setOpenTeam(justConnectedTeam);
    }
  }, [justConnectedTeam, workspaces]);

  if (asCard) {
    const cardList = workspaces ?? [];
    const cardCount = cardList.length;
    const isConnected = connected ?? scopeConnected ?? false;
    return (
      <div
        id="connector-slack"
        className={`scroll-mt-24 flex flex-col gap-3 rounded-[16px] border bg-white px-4 py-[19px] transition-shadow col-span-full ${
          highlighted
            ? "border-emerald-400 ring-2 ring-emerald-300/60"
            : "border-[#f0f0f0]"
        }`}
      >
        {}
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <ConnectorLockup slug="slack" label="Slack" />
            <p className="truncate text-[13px] leading-[18px] text-inkMuted">
              {purposeFor("slack", "Slack")}
            </p>
            <div className="flex items-center gap-2 text-[13px] leading-[16px]">
              <TileState
                tone={isConnected ? "connected" : "idle"}
                text={isConnected ? "Connected" : "Not connected"}
              />
              {isConnected && cardCount > 0 && (
                <>
                  <span aria-hidden className="inline-block h-1 w-1 rounded-full bg-[#d0d0d0]" />
                  <span className="font-medium text-ink">
                    {cardCount} Workspace{cardCount === 1 ? "" : "s"}
                  </span>
                </>
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {readOnly ? null : isConnected ? (
              <TileButton
                onClick={() => setExpanded((v) => !v)}
                ariaExpanded={expanded}
                ariaControls="connector-slack-body"
              >
                {expanded ? "Done" : "Manage"}
              </TileButton>
            ) : (
              <ConnectButton slug="slack" connected={isConnected} />
            )}
          </div>
        </div>

        {}
        {oauthErrorBanner}

        {expanded && isConnected && !readOnly && (
          <div id="connector-slack-body" className="flex flex-col gap-3 border-t border-[#f0f0f0] pt-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[13px] font-medium text-inkMuted">
                Each workspace you add stacks. It never replaces the ones above.
              </span>
              <TileButton onClick={beginConnect}>+ Add Slack Workspace</TileButton>
            </div>
            {cardList.map((w) => (
              <WorkspaceCard
                key={w.team_id}
                ws={w}
                agentSlugs={agentSlugs}
                open={openTeam === w.team_id}
                onToggle={() =>
                  setOpenTeam((cur) => (cur === w.team_id ? undefined : w.team_id))
                }
                onSaved={() => void load()}
              />
            ))}
          </div>
        )}

        {isConnected && readOnly && cardCount > 0 && (
          <div className="flex flex-col gap-2 border-t border-[#f0f0f0] pt-3">
            {cardList.map((w) => (
              <div
                key={w.team_id}
                className="flex items-center gap-2.5 rounded-[16px] border border-[#f0f0f0] px-4 py-2.5"
              >
                <WorkspaceAvatar
                  iconUrl={w.team_icon_url}
                  name={w.label || w.team_name || w.team_id}
                  size={30}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[16px] font-semibold leading-[20px] text-[#1d1c1d]">
                      {w.label || w.team_name || w.team_id}
                    </span>
                    {w.is_primary && <PrimaryTag />}
                  </div>
                  <div className="truncate text-[13px] leading-[18px] text-[#595959]">
                    purpose: {w.purpose}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (!embedded && (loading || !workspaces || workspaces.length === 0)) {
    return null;
  }

  const list = workspaces ?? [];
  const count = list.length;
  const wrapperClass = embedded
    ? "mt-2 sm:col-span-2"
    : "rounded-xl border border-ink/[0.08] bg-white px-3.5 py-3 sm:col-span-2";

  return (
    <div className={wrapperClass}>
      {oauthErrorBanner}
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="text-[12px] font-medium text-ink">
          {loading && count === 0
            ? "Slack workspaces"
            : `Slack · ${count} workspace${count === 1 ? "" : "s"} connected`}
        </div>
        <button
          type="button"
          onClick={beginConnect}
          className="rounded-cta bg-ink px-2.5 py-1 text-[12px] font-medium text-white hover:bg-inkSoft transition-colors"
        >
          + Add Slack workspace
        </button>
      </div>
      <p className="mb-2 text-[11px] text-inkMuted leading-[1.5]">
        Adds a separate workspace (e.g. your support Slack). Won&apos;t replace
        the ones above.
      </p>

      <div className="space-y-1.5">
        {list.map((w) => (
          <WorkspaceCard
            key={w.team_id}
            ws={w}
            agentSlugs={agentSlugs}
            open={openTeam === w.team_id}
            onToggle={() =>
              setOpenTeam((cur) => (cur === w.team_id ? undefined : w.team_id))
            }
            onSaved={() => void load()}
          />
        ))}
      </div>
    </div>
  );
}

function WorkspaceCard({
  ws,
  agentSlugs,
  open,
  onToggle,
  onSaved,
}: {
  ws: Workspace;
  agentSlugs: string[];
  open: boolean;
  onToggle: () => void;
  onSaved: () => void;
}) {
  const initialPurpose: Purpose =
    (PURPOSES as readonly string[]).includes(ws.purpose) && ws.purpose !== "general"
      ? (ws.purpose as Purpose)
      : ws.suggested_purpose ?? "general";

  const [purpose, setPurpose] = useState<Purpose>(initialPurpose);
  const [label, setLabel] = useState(ws.label || ws.team_name || "");
  const [defaultAgent, setDefaultAgent] = useState(ws.default_agent_slug ?? "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      const res = await apiFetch("/api/connectors/slack/workspace-meta", {
        method: "POST",
        body: JSON.stringify({
          team_id: ws.team_id,
          purpose,
          label,
          default_agent_slug: defaultAgent,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        setErr(body?.error?.message ?? `HTTP ${res.status}`);
        return;
      }
      setSavedAt(Date.now());
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-[16px] border border-[#f0f0f0] bg-white px-4 py-2.5">
      {}
      <div className="flex items-center gap-3">
        <WorkspaceAvatar
          iconUrl={ws.team_icon_url}
          name={ws.label || ws.team_name || ws.team_id}
          size={37}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[16px] font-semibold leading-[20px] text-[#1d1c1d]">
              {ws.label || ws.team_name || ws.team_id}
            </span>
            {ws.is_primary && <PrimaryTag />}
          </div>
          <div className="truncate text-[13px] font-medium leading-[18px] text-[#595959]">
            purpose: {ws.purpose}
            {ws.default_agent_slug ? ` · default: ${ws.default_agent_slug}` : ""}
            {ws.missing.length > 0 ? ` · ${ws.missing.length} scope(s) pending` : ""}
          </div>
        </div>
        <SlackConnectedPill />
        {}
        <button
          type="button"
          onClick={onToggle}
          aria-label="Workspace options"
          aria-expanded={open}
          className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-cta border bg-white transition-colors ${
            open
              ? "border-[#e0e0e0] bg-[#fafafa] text-[#1f1f1f]"
              : "border-[#f0f0f0] text-[#1f1f1f] hover:border-[#e0e0e0] hover:bg-[#fafafa]"
          }`}
        >
          <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <circle cx="5" cy="12" r="1.6" />
            <circle cx="12" cy="12" r="1.6" />
            <circle cx="19" cy="12" r="1.6" />
          </svg>
        </button>
      </div>

      {open && (
        <div className="mt-3 flex flex-col gap-3 border-t border-[#f0f0f0] pt-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <FieldLabel label="What is this Slack for?">
              <SelectField
                value={purpose}
                onChange={(v) => setPurpose(v as Purpose)}
                options={PURPOSES.map((p) => ({ value: p, label: p }))}
              />
            </FieldLabel>

            <FieldLabel label="Label">
              <input
                type="text"
                value={label}
                maxLength={80}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Support Slack"
                className="h-10 w-full rounded-[10px] border border-[#f0f0f0] bg-white px-3 text-[16px] font-medium leading-[20px] text-[#1f1f1f] outline-none transition-colors placeholder:text-[#bfbfbf] focus:border-[#027bff] focus:ring-2 focus:ring-[#027bff]/15"
              />
            </FieldLabel>

            <FieldLabel label="Default agent">
              <SelectField
                value={defaultAgent}
                onChange={setDefaultAgent}
                options={[
                  { value: "", label: "(operator / none)" },
                  ...(ws.default_agent_slug &&
                  !agentSlugs.includes(ws.default_agent_slug)
                    ? [{ value: ws.default_agent_slug, label: ws.default_agent_slug }]
                    : []),
                  ...agentSlugs.map((s) => ({ value: s, label: s })),
                ]}
              />
            </FieldLabel>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving}
              className="inline-flex h-10 items-center justify-center rounded-cta bg-[#1f1f1f] px-4 text-[16px] font-semibold leading-[20px] text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
            {savedAt && !err && (
              <span className="text-[13px] font-medium text-[#167f50]">Saved ✓</span>
            )}
            {err && (
              <span className="text-[13px] font-medium text-rose-700">{err}</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function FieldLabel({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-2">
      <span className="text-[14px] font-medium leading-5 text-[#595959]">
        {label}
      </span>
      {children}
    </label>
  );
}

function SelectField({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-10 w-full appearance-none rounded-[10px] border border-[#f0f0f0] bg-white pl-3 pr-9 text-[16px] font-medium leading-[20px] text-[#1f1f1f] outline-none transition-colors focus:border-[#027bff] focus:ring-2 focus:ring-[#027bff]/15"
      >
        {options.map((o) => (
          <option key={o.value || "__none"} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <svg
        className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#595959]"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="m6 9 6 6 6-6" />
      </svg>
    </div>
  );
}

function PrimaryTag() {
  return (
    <span className="shrink-0 rounded-[3px] bg-[#f5faf8] px-1 py-px text-[11px] font-semibold leading-none text-[#167f50]">
      Primary
    </span>
  );
}

function SlackConnectedPill() {
  return (
    <span className="hidden shrink-0 items-center gap-1 rounded-[36px] bg-[#f5faf8] py-1.5 pl-2 pr-2.5 text-[13px] font-medium leading-[18px] text-[#167f50] sm:inline-flex">
      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="m5 12.5 4.2 4.2L19 7" />
      </svg>
      Connected
    </span>
  );
}

const AVATAR_PALETTE = [
  "#2563eb",
  "#7c3aed",
  "#0e9f6e",
  "#e9713b",
  "#db2777",
  "#0891b2",
  "#ca8a04",
  "#4f46e5",
];
function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "#";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}
function colorOf(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length];
}
function WorkspaceAvatar({
  iconUrl,
  name,
  size,
}: {
  iconUrl?: string | null;
  name: string;
  size: number;
}) {
  const radius = Math.round(size * 0.19);
  if (iconUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- remote Slack CDN icon
      <img
        src={iconUrl}
        alt=""
        className="shrink-0 object-cover"
        style={{ width: size, height: size, borderRadius: radius }}
      />
    );
  }
  return (
    <span
      aria-hidden
      className="flex shrink-0 items-center justify-center font-semibold text-white"
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        backgroundColor: colorOf(name),
        fontSize: Math.round(size * 0.4),
      }}
    >
      {initialsOf(name)}
    </span>
  );
}
