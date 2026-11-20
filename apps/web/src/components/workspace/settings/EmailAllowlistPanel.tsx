"use client";

import { useCallback, useEffect, useState } from "react";
import { Mail, X, TriangleAlert, Check, Copy, Users, Globe, AtSign } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { Switch } from "@/components/ui/Switch";
import { Skeleton } from "../Skeleton";

type Entry = { id: string; kind: "address" | "domain"; value: string; created_at: string };
type Member = { user_id: string; email: string; role: string };

export function EmailAllowlistPanel({ canEdit }: { canEdit: boolean }) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [inboxAddress, setInboxAddress] = useState<string | null | undefined>(undefined);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [disabledIds, setDisabledIds] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [membersFailed, setMembersFailed] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await apiFetch("/api/tenant/me/email-allowlist");
      if (!r.ok) throw new Error(String(r.status));
      const j = (await r.json()) as { entries: Entry[] };
      setEntries(j.entries ?? []);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
      setEntries([]);
    }
  }, []);

  const loadMembers = useCallback(async () => {
    try {
      const [mr, dr] = await Promise.all([
        apiFetch("/api/v1/members"),
        apiFetch("/api/tenant/me/email-members"),
      ]);
      if (!mr.ok || !dr.ok) throw new Error("load failed");
      const mj = (await mr.json()) as { members?: Member[] };
      const dj = (await dr.json()) as { disabled_user_ids?: string[] };
      setMembers(mj.members ?? []);
      setDisabledIds(new Set(dj.disabled_user_ids ?? []));
      setMembersFailed(false);
    } catch {
      setMembersFailed(true);
      setMembers([]);
    }
  }, []);

  const loadAddress = useCallback(async () => {
    try {
      const r = await apiFetch("/api/workspace/inbox-addresses");
      if (!r.ok) throw new Error("no address");
      const j = (await r.json()) as { address: string | null };
      setInboxAddress(j.address ?? null);
    } catch {
      setInboxAddress(null);
    }
  }, []);

  useEffect(() => {
    void load();
    void loadMembers();
    void loadAddress();
  }, [load, loadMembers, loadAddress]);

  const toggleMember = useCallback(
    async (user_id: string, enabled: boolean) => {
      setBusy(true);
      setError(null);
      setDisabledIds((prev) => {
        const next = new Set(prev);
        if (enabled) next.delete(user_id);
        else next.add(user_id);
        return next;
      });
      try {
        const r = await apiFetch("/api/tenant/me/email-members", {
          method: "POST",
          body: JSON.stringify({ user_id, enabled }),
        });
        if (!r.ok) {
          const j = (await r.json().catch(() => null)) as
            | { error?: { code?: string; message?: string } }
            | null;
          throw new Error(
            j?.error?.code === "admin_only"
              ? "Only an owner or admin can change this."
              : j?.error?.code === "owner_email_always_on"
                ? "Owners always have email access."
                : (j?.error?.message ?? "could not save"),
          );
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "could not save");
        setDisabledIds((prev) => {
          const next = new Set(prev);
          if (enabled) next.add(user_id);
          else next.delete(user_id);
          return next;
        });
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const add = useCallback(async () => {
    const value = draft.trim();
    if (!value) return;
    setBusy(true);
    setError(null);
    try {
      const r = await apiFetch("/api/tenant/me/email-allowlist", {
        method: "POST",
        body: JSON.stringify({ value }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => null)) as
          | { error?: { code?: string; message?: string } }
          | null;
        throw new Error(
          j?.error?.code === "cap_reached"
            ? "You've hit the 50-entry limit. Remove one first."
            : j?.error?.code === "admin_only"
              ? "Only an owner or admin can change who may email your agent."
              : (j?.error?.message ?? "could not add"),
        );
      }
      setDraft("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not add");
    } finally {
      setBusy(false);
    }
  }, [draft, load]);

  const remove = useCallback(
    async (id: string) => {
      setBusy(true);
      setError(null);
      try {
        const r = await apiFetch(`/api/tenant/me/email-allowlist/${id}`, { method: "DELETE" });
        if (!r.ok) {
          const j = (await r.json().catch(() => null)) as
            | { error?: { code?: string; message?: string } }
            | null;
          throw new Error(j?.error?.message ?? "could not remove");
        }
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : "could not remove");
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const copyAddress = useCallback(async () => {
    if (!inboxAddress) return;
    try {
      await navigator.clipboard.writeText(inboxAddress);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
    }
  }, [inboxAddress]);

  const addresses = (entries ?? []).filter((e) => e.kind === "address");
  const domains = (entries ?? []).filter((e) => e.kind === "domain");

  return (
    <div className="space-y-5">
      {}
      <Card icon={<Mail className="mt-0.5 h-5 w-5 shrink-0 text-[#595959]" aria-hidden />}>
        <h3 className="text-[14px] font-semibold text-[#0e0f11]">Your agent&apos;s email address</h3>
        <p className="mt-1 text-[13px] leading-[1.6] text-[#595959]">
          Email this address, or CC it onto a thread, and your agent reads it and replies.
        </p>

        {inboxAddress === undefined ? (
          <Skeleton className="mt-4 h-10 w-2/3" />
        ) : inboxAddress === null ? (
          <Row muted>Not set up yet.</Row>
        ) : (
          <div className="mt-4 flex items-center justify-between gap-3 rounded-xl bg-[#f9f9f9] px-3 py-2.5">
            <code className="min-w-0 flex-1 truncate text-[13px] text-[#0e0f11]">{inboxAddress}</code>
            <button
              type="button"
              onClick={() => void copyAddress()}
              aria-label="Copy address"
              className="shrink-0 rounded-cta p-1 text-[#595959] hover:bg-white hover:text-[#0e0f11]"
            >
              {copied ? (
                <Check className="h-4 w-4 text-[#1a7f37]" aria-hidden />
              ) : (
                <Copy className="h-4 w-4" aria-hidden />
              )}
            </button>
          </div>
        )}
      </Card>

      {}
      <Card icon={<Users className="mt-0.5 h-5 w-5 shrink-0 text-[#595959]" aria-hidden />}>
        <h3 className="text-[14px] font-semibold text-[#0e0f11]">Your team</h3>
        <p className="mt-1 text-[13px] leading-[1.6] text-[#595959]">
          Everyone in your workspace can email your agent. Switch someone off to stop that. They
          keep the rest of Zavi either way.
        </p>

        {members === null ? (
          <div className="mt-4 space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-2/3" />
          </div>
        ) : membersFailed ? (
          <RetryRow
            label="Couldn't load your team just now."
            onRetry={() => {
              setMembers(null);
              void loadMembers();
            }}
          />
        ) : (
          <ul className="mt-4 space-y-2">
            {members.map((m) => {
              const isOwner = m.role === "owner";
              const on = isOwner || !disabledIds.has(m.user_id);
              return (
                <li
                  key={m.user_id}
                  className="flex items-center justify-between gap-3 rounded-full bg-creamDeep px-4 py-2"
                >
                  <span className="min-w-0 flex-1 truncate text-base text-ink">
                    {m.email}
                    <span className="ml-2 text-xs capitalize text-inkLight">{m.role}</span>
                    {isOwner && (
                      <span className="block text-xs text-inkLight">
                        Owners always have email access
                      </span>
                    )}
                  </span>
                  <Switch
                    checked={on}
                    label={
                      isOwner
                        ? `Email is always on for ${m.email} (owner)`
                        : `${on ? "Disable" : "Enable"} email for ${m.email}`
                    }
                    disabled={isOwner || !canEdit || busy}
                    onCheckedChange={(checked) => void toggleMember(m.user_id, checked)}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {}
      <Card icon={<AtSign className="mt-0.5 h-5 w-5 shrink-0 text-[#595959]" aria-hidden />}>
        <h3 className="text-[14px] font-semibold text-[#0e0f11]">Specific people</h3>
        <p className="mt-1 text-[13px] leading-[1.6] text-[#595959]">
          People outside your workspace who can email your agent.
        </p>

        {entries === null ? (
          <div className="mt-4 space-y-2">
            <Skeleton className="h-10 w-full" />
          </div>
        ) : loadFailed ? (
          <RetryRow
            label="Couldn't load your list just now."
            onRetry={() => {
              setEntries(null);
              void load();
            }}
          />
        ) : addresses.length === 0 ? (
          <Row muted>Nobody outside your workspace.</Row>
        ) : (
          <EntryList entries={addresses} canEdit={canEdit} busy={busy} onRemove={remove} />
        )}
      </Card>

      {}
      <Card icon={<Globe className="mt-0.5 h-5 w-5 shrink-0 text-[#595959]" aria-hidden />}>
        <h3 className="text-[14px] font-semibold text-[#0e0f11]">Whole companies</h3>
        <p className="mt-1 text-[13px] leading-[1.6] text-[#595959]">
          Anyone with an address at these domains can email your agent. Subdomains aren&apos;t
          included. Add <code className="text-[12px]">mail.acme.com</code> separately if you need it.
        </p>

        {entries === null ? (
          <div className="mt-4 space-y-2">
            <Skeleton className="h-10 w-full" />
          </div>
        ) : loadFailed ? (
          <Row muted>Couldn&apos;t load your list just now.</Row>
        ) : domains.length === 0 ? (
          <Row muted>No companies added.</Row>
        ) : (
          <EntryList entries={domains} canEdit={canEdit} busy={busy} onRemove={remove} />
        )}
      </Card>

      {}
      {}
      {canEdit && (
        <div className="rounded-block border border-[#f0f0f0] px-4 py-[19px]">
          <div className="flex gap-2">
            <label htmlFor="email-allowlist-entry" className="sr-only">
              Email address or domain
            </label>
            <input
              id="email-allowlist-entry"
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void add();
                }
              }}
              placeholder="ops@partner.com  or  partner.com"
              className="min-w-0 flex-1 rounded-xl border border-[#f0f0f0] px-3 py-2 text-[13px] text-[#0e0f11] outline-none focus:border-[#0e0f11]"
            />
            <button
              type="button"
              onClick={() => void add()}
              disabled={busy || draft.trim().length === 0}
              className="shrink-0 rounded-cta bg-[#0e0f11] px-4 py-2 text-[13px] font-medium text-white disabled:opacity-40"
            >
              Add
            </button>
          </div>

          {}
          <p className="mt-2.5 flex items-start gap-2 text-[12px] leading-[1.6] text-[#595959]">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#ffce70]" aria-hidden />
            <span>Anyone you add can ask your agent about your business and gets its answer back.</span>
          </p>

          {error && (
            <p role="alert" className="mt-2 text-[12px] text-[#cb2029]">
              {error}
            </p>
          )}

          {}
          <p className="mt-3 border-t border-[#f6f6f6] pt-2.5 text-[12px] leading-[1.6] text-[#8a8a8a]">
            Senders are verified before your agent answers, so nobody gets in by faking an address
            you&apos;ve added. Public providers like Gmail can only be added one address at a time,
            never as a whole company.
          </p>
        </div>
      )}

      {!canEdit && (
        <p className="px-1 text-[12px] text-[#595959]">
          Only an owner or admin can change who can email your agent.
        </p>
      )}
    </div>
  );
}

function Card({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-block border border-[#f0f0f0] px-4 py-[19px]">
      <div className="flex items-start gap-3">
        {icon}
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}

function Row({ children, muted }: { children: React.ReactNode; muted?: boolean }) {
  return (
    <p
      className={`mt-4 rounded-xl bg-[#f9f9f9] px-3 py-2.5 text-[13px] ${
        muted ? "text-[#595959]" : "text-[#0e0f11]"
      }`}
    >
      {children}
    </p>
  );
}

function RetryRow({ label, onRetry }: { label: string; onRetry: () => void }) {
  return (
    <div className="mt-4 flex items-center justify-between gap-3 rounded-xl bg-[#f9f9f9] px-3 py-2.5">
      <span className="text-[13px] text-[#595959]">{label}</span>
      <button
        type="button"
        onClick={onRetry}
        className="shrink-0 rounded-cta px-2 py-1 text-[13px] font-medium text-[#0e0f11] hover:bg-white"
      >
        Retry
      </button>
    </div>
  );
}

function EntryList({
  entries,
  canEdit,
  busy,
  onRemove,
}: {
  entries: Entry[];
  canEdit: boolean;
  busy: boolean;
  onRemove: (id: string) => void;
}) {
  return (
    <ul className="mt-4 space-y-2">
      {entries.map((e) => (
        <li
          key={e.id}
          className="flex items-center justify-between gap-3 rounded-xl bg-[#f9f9f9] px-3 py-2.5"
        >
          <span className="min-w-0 flex-1 truncate text-[13px] text-[#0e0f11]">{e.value}</span>
          {canEdit && (
            <button
              type="button"
              onClick={() => onRemove(e.id)}
              disabled={busy}
              aria-label={`Remove ${e.value}`}
              className="shrink-0 rounded-cta p-1 text-[#595959] hover:bg-white hover:text-[#cb2029] disabled:opacity-40"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
