"use client";

import { useCallback, useEffect, useState } from "react";
import { Copy, Check, ChevronRight, KeyRound, Plus, Trash2, TriangleAlert } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { SlidingIndicator, useSlidingIndicator } from "@/components/ui/SlidingIndicator";
import { Skeleton } from "../Skeleton";

const MCP_URL = "https://api.zaviagent.com/mcp";

const TOOLS: { name: string; what: string }[] = [
  { name: "zavi_ask", what: "Ask the operator anything. It scopes the work or hands off" },
  { name: "zavi_list_agents", what: "List the agents your workspace can run" },
  { name: "zavi_run_agent", what: "Run one agent by slug" },
  { name: "zavi_get_run_status", what: "Poll a run for status + result" },
  { name: "zavi_recent_runs", what: "Recent runs, newest first" },
  { name: "zavi_read_brain", what: "Read your company-brain notes" },
  { name: "zavi_search", what: "Search notes + runs" },
  { name: "zavi_fetch", what: "Fetch one search result in full" },
  { name: "zavi_next_step", what: "Your goals, open growth steps and tests due" },
  { name: "zavi_mark_step_done", what: "Mark a growth step done, with what changed" },
  { name: "zavi_report_number", what: "Save a goal's current number" },
];

type Step = { text: string; path?: string[]; after?: string; copy?: { value: string; label: string } };

type Client = { id: string; label: string; summary: string; steps: Step[] };

const CLIENTS: Client[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    summary: "Run your agents from the terminal.",
    steps: [
      { text: "Run this in your terminal", copy: { value: `claude mcp add --transport http zavi ${MCP_URL}`, label: "Claude Code command" } },
      { text: "Run /mcp in Claude Code and finish the browser login" },
    ],
  },
  {
    id: "claude-ai",
    label: "claude.ai",
    summary: "Ask Zavi from any claude.ai chat.",
    steps: [
      { text: "Copy the connection URL above" },
      { text: "In claude.ai, open", path: ["Settings", "Connectors", "Add custom connector"], after: "and paste it" },
      { text: "Approve access in the popup" },
    ],
  },
  {
    id: "chatgpt",
    label: "ChatGPT",
    summary: "Needs Developer Mode on an admin-enabled workspace.",
    steps: [
      { text: "Copy the connection URL above" },
      { text: "In ChatGPT, open", path: ["Settings", "Connectors"], after: "and add it as a new connector" },
      { text: "Complete the sign-in when ChatGPT asks" },
    ],
  },
  {
    id: "other",
    label: "Other app",
    summary: "Any app that supports MCP connectors or plugins.",
    steps: [
      { text: "Copy the connection URL above" },
      { text: "Add it to your AI tool as a custom connector or MCP server" },
      { text: "Approve access in your browser, then ask your AI to run your Zavi agents" },
    ],
  },
];

type Pat = {
  id: string;
  name: string;
  token_prefix: string;
  scopes: string[];
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
};

function CopyButton({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        });
      }}
      aria-label={copied ? "Copied" : label ? `Copy ${label}` : "Copy"}
      title={copied ? "Copied" : "Copy"}
      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-inkMuted transition-colors hover:bg-ink/[0.06] hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30"
    >
      {copied ? <Check className="h-4 w-4 text-success" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
    </button>
  );
}

export function McpClientsPanel({ showTokens = true }: { showTokens?: boolean }) {
  return (
    <div className="flex flex-col gap-10">
      <ConnectCard />
      {showTokens && <TokensCard />}
    </div>
  );
}

function CopyField({ value, label }: { value: string; label: string }) {
  return (
    <div data-testid="mcp-copy-field" className="flex min-w-0 items-center gap-2 rounded-xl border border-rule bg-cream py-1 pl-3.5 pr-1">
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap py-1.5 font-mono text-[14px] leading-5 text-ink [scrollbar-width:none]">
        {value}
      </code>
      <CopyButton value={value} label={label} />
    </div>
  );
}

function MenuPath({ path }: { path: string[] }) {
  return (
    <span data-testid="mcp-menu-path" className="contents">
      {path.map((part, i) => (
        <span key={part} className="inline-flex items-center gap-1">
          <span className="whitespace-nowrap rounded-md bg-ink/[0.07] px-1.5 py-0.5 text-[13px] font-medium leading-5 text-ink ring-1 ring-inset ring-ink/[0.06]">
            {part}
          </span>
          {i < path.length - 1 && <ChevronRight data-testid="mcp-path-sep" className="h-4 w-4 shrink-0 text-inkSoft" strokeWidth={2.25} aria-hidden />}
        </span>
      ))}
    </span>
  );
}

function Steps({ steps }: { steps: Step[] }) {
  return (
    <ol className="flex flex-col gap-3.5">
      {steps.map((step, i) => (
        <li key={step.text} className="flex flex-col gap-2">
          <div className="flex items-start gap-3 text-[14px] leading-6 text-ink">
            <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-ink/[0.08] text-[12px] font-semibold leading-none tabular-nums text-inkMuted">
              {i + 1}
            </span>
            <span className="min-w-0">
              {step.text}
              {step.path ? (
                <span className="mt-1.5 flex flex-wrap items-center gap-x-1 gap-y-1.5">
                  <MenuPath path={step.path} />
                  {step.after && <span className="ml-0.5">{step.after}</span>}
                </span>
              ) : (
                step.after && <> {step.after}</>
              )}
            </span>
          </div>
          {step.copy && (
            <div className="pl-9">
              <CopyField value={step.copy.value} label={step.copy.label} />
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}

function ConnectCard() {
  const [active, setActive] = useState(CLIENTS[0]!.id);
  const client = CLIENTS.find((c) => c.id === active) ?? CLIENTS[0]!;
  const { listRef, box } = useSlidingIndicator<HTMLDivElement>(active);
  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <h3 className="text-[18px] font-semibold leading-6 text-ink">Connect your AI client</h3>
        <p className="max-w-[60ch] text-[14px] leading-[21px] text-inkMuted">
          Add Zavi to Claude Code, claude.ai or ChatGPT once, approve in the browser, and your client can ask Zavi questions
          and run your agents. There is no token to copy.
        </p>
      </div>

      <div data-testid="mcp-url-hero" className="flex flex-col gap-2">
        <span className="text-[13px] font-medium text-inkMuted">Your connection URL</span>
        <CopyField value={MCP_URL} label="server URL" />
      </div>

      <div className="flex flex-col gap-4">
        <div ref={listRef} role="tablist" aria-label="AI client" className="relative flex gap-5 overflow-x-auto border-b border-rule [scrollbar-width:none]">
          <SlidingIndicator box={box} className="border-b-2 border-ink" />
          {CLIENTS.map((c) => {
            const selected = c.id === active;
            return (
              <button
                key={c.id}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls="mcp-client-panel"
                data-testid={`mcp-tab-${c.id}`}
                onClick={() => setActive(c.id)}
                className={`relative -mb-px shrink-0 whitespace-nowrap border-b-2 border-transparent pb-2.5 text-[14px] font-medium transition-colors duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30 ${
                  selected ? "text-ink" : "text-inkMuted hover:text-ink"
                }`}
              >
                {c.label}
              </button>
            );
          })}
        </div>

        <div id="mcp-client-panel" role="tabpanel" data-testid={`mcp-client-${client.id}`} className="flex flex-col gap-4">
          <p className="text-[14px] leading-5 text-inkMuted">{client.summary}</p>
          <Steps steps={client.steps} />
        </div>
      </div>

      <details className="group/tools rounded-xl border border-rule" data-testid="mcp-tools">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-xl px-4 py-3 text-[14px] font-semibold leading-5 text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30 [&::-webkit-details-marker]:hidden">
          <span>
            What your client can do once connected
            <span className="font-normal text-inkMuted"> · {TOOLS.length} tools</span>
          </span>
          <ChevronRight className="h-4 w-4 shrink-0 text-inkMuted transition-transform group-open/tools:rotate-90 motion-reduce:transition-none" aria-hidden />
        </summary>
        <div className="border-t border-rule px-4 pb-4 pt-3">
          <ul className="grid gap-x-6 gap-y-2.5 sm:grid-cols-2">
            {TOOLS.map((t) => (
              <li key={t.name} className="flex flex-col gap-0.5">
                <code className="font-mono text-[13px] leading-5 text-ink">{t.name}</code>
                <span className="text-[13px] leading-5 text-inkMuted">{t.what}</span>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-[13px] leading-[18px] text-inkMuted">
            Ad changes Zavi makes from a run started in your AI client are never applied
            without your approval, even with Autopilot on, a spend cap set, or a custom
            agent doing the work. A change you ask your AI client to make with its own
            tools doesn&apos;t go through Zavi. Posting and sending email follow your
            approval settings, as they do in Zavi. Runs from your AI client use your credits and
            can&apos;t make AI images, video or audio, or take or send payments.
          </p>
        </div>
      </details>
    </section>
  );
}

function TokensCard() {
  const [pats, setPats] = useState<Pat[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [showMint, setShowMint] = useState(false);
  const [freshToken, setFreshToken] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch("/api/auth/pat");
      if (!res.ok) {
        setLoadFailed(true);
        return;
      }
      const json = (await res.json()) as { pats?: Pat[] };
      setPats(json.pats ?? []);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const mint = useCallback(async () => {
    const name = draftName.trim();
    if (!name) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch("/api/auth/pat", {
        method: "POST",
        body: JSON.stringify({ name, scopes: ["read", "run"] }),
      });
      const json = (await res.json()) as { token?: string; error?: { message?: string } };
      if (!res.ok || !json.token) {
        setError(json.error?.message ?? "Couldn't create the token.");
        return;
      }
      setFreshToken(json.token);
      setDraftName("");
      setShowMint(false);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [draftName, load]);

  const revoke = useCallback(
    async (id: string) => {
      setBusy(true);
      setError(null);
      try {
        const res = await apiFetch(`/api/auth/pat/${id}`, { method: "DELETE" });
        if (!res.ok && res.status !== 204) {
          setError("Couldn't revoke that token.");
          return;
        }
        await load();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const live = (pats ?? []).filter((p) => !p.revoked_at);

  return (
    <section className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <h3 className="text-[20px] font-semibold leading-[28px] tracking-tight text-ink">
          Access tokens
        </h3>
        <p className="text-[16px] leading-[20px] text-inkMuted">
          Only needed for a script, a CI job, or a client that can&apos;t do the
          browser login above. A token carries your own access to this workspace
          (including running agents), so treat it like a password.
        </p>
      </div>

      {freshToken && (
        <div className="flex flex-col gap-2 rounded-xl border border-marigold/30 bg-marigold/10 p-3.5">
          <div className="flex items-center gap-2 text-[16px] font-semibold leading-[20px] text-ink">
            <KeyRound className="h-4 w-4" />
            Copy this now. It won&apos;t be shown again
          </div>
          <div className="flex items-center gap-2">
            <code data-replay-mask="" className="min-w-0 flex-1 truncate font-mono text-[13px] text-ink">
              {freshToken}
            </code>
            <CopyButton value={freshToken} label="token" />
          </div>
          <button
            type="button"
            onClick={() => setFreshToken(null)}
            className="self-start text-[13px] font-medium text-inkMuted underline underline-offset-2 hover:text-ink"
          >
            I&apos;ve stored it
          </button>
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 p-3.5 text-[16px] leading-[19px] text-danger">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {loadFailed ? (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-rule bg-transparent p-3.5">
          <span className="text-[16px] leading-[19px] text-inkMuted">
            Couldn&apos;t load your tokens, so this list may be incomplete.
          </span>
          <button
            type="button"
            onClick={() => void load()}
            className="shrink-0 text-[16px] font-semibold text-ink underline underline-offset-2"
          >
            Retry
          </button>
        </div>
      ) : pats === null ? (
        <Skeleton className="h-20 w-full rounded-xl" />
      ) : live.length === 0 ? (
        <p className="text-[16px] leading-[19px] text-inkMuted">
          No tokens yet. Most people never need one.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {live.map((p) => (
            <li
              key={p.id}
              className="flex items-center justify-between gap-3 rounded-xl border border-rule bg-transparent p-3.5"
            >
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate text-[16px] font-semibold leading-[20px] text-ink">
                  {p.name}
                </span>
                <span className="truncate font-mono text-[13px] leading-[18px] text-inkMuted">
                  {p.token_prefix}… · {p.scopes.join(", ")} · created{" "}
                  {new Date(p.created_at).toLocaleDateString()}
                </span>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => void revoke(p.id)}
                aria-label={`Revoke ${p.name}`}
                className="inline-flex h-10 shrink-0 items-center gap-2 rounded-cta border border-rule bg-transparent px-3 text-[16px] font-semibold text-danger transition-colors hover:border-danger/40 hover:bg-danger/10 disabled:opacity-50"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}

      {showMint ? (
        <div className="flex flex-col gap-2.5 rounded-xl border border-rule bg-transparent p-3.5">
          <label htmlFor="pat-name" className="text-[14px] font-medium text-ink">
            What is this token for?
          </label>
          <input
            id="pat-name"
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && draftName.trim() && !busy) void mint();
            }}
            placeholder="e.g. nightly report script"
            maxLength={80}
            className="h-10 rounded-[10px] border border-rule bg-transparent px-3 text-[16px] text-ink outline-none focus:border-ink/40"
          />
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy || !draftName.trim()}
              onClick={() => void mint()}
              className="inline-flex h-10 items-center rounded-cta bg-ink px-4 text-[14px] font-semibold text-cream transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              {busy ? "Creating…" : "Create token"}
            </button>
            <button
              type="button"
              onClick={() => {
                setShowMint(false);
                setDraftName("");
              }}
              className="inline-flex h-10 items-center rounded-cta border border-rule bg-transparent px-4 text-[16px] font-semibold text-ink"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setShowMint(true)}
          className="inline-flex h-10 w-fit items-center gap-2 rounded-cta border border-rule bg-transparent px-4 text-[16px] font-semibold text-ink transition-colors hover:bg-bone"
        >
          <Plus className="h-4 w-4" />
          New token
        </button>
      )}
    </section>
  );
}
