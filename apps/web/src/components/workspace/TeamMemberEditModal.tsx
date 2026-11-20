"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import type { TeamMemberDetail } from "@/lib/team/types";

type Kind = "human" | "bot" | "service_account";

const PROVIDER_LOGO: Record<"github" | "jira" | "slack", string> = {
  slack: "/team/slack.svg",
  jira: "/team/jira.svg",
  github: "/team/github.svg",
};

const PROVIDER_LABEL: Record<"github" | "jira" | "slack", string> = {
  slack: "Slack",
  jira: "Jira",
  github: "GitHub",
};

export function TeamMemberEditModal({
  memberId,
  onClose,
  onSaved,
}: {
  memberId: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [detail, setDetail] = useState<TeamMemberDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [displayName, setDisplayName] = useState("");
  const [primaryEmail, setPrimaryEmail] = useState("");
  const [kind, setKind] = useState<Kind>("human");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch(`/api/team/members/${memberId}`);
        if (cancelled) return;
        if (!res.ok) {
          setError(`fetch_failed:${res.status}`);
          setLoading(false);
          return;
        }
        const json = (await res.json()) as { member?: TeamMemberDetail };
        if (json.member) {
          setDetail(json.member);
          setDisplayName(json.member.display_name);
          setPrimaryEmail(json.member.primary_email ?? "");
          setKind(json.member.kind);
        }
        setLoading(false);
      } catch (e) {
        if (!cancelled) {
          setError((e as Error).message);
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [memberId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !saving) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [saving, onClose]);

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/team/members/${memberId}/update`, {
        method: "POST",
        body: JSON.stringify({
          display_name: displayName.trim() || undefined,
          primary_email: primaryEmail.trim(),
          kind,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: { code?: string; message?: string } }
          | null;
        setError(body?.error?.message ?? `save_failed:${res.status}`);
        return;
      }
      await onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 px-4 backdrop-blur-[2px]"
      onClick={() => {
        if (!saving) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-member-title"
        className="w-full max-w-lg overflow-hidden rounded-[20px] border border-[#f0f0f0] bg-white shadow-[0_12px_40px_rgba(14,15,17,0.16),0_2px_8px_rgba(14,15,17,0.08)]"
        onClick={(e) => e.stopPropagation()}
      >
        {}
        <div className="flex items-center justify-between border-b border-[#f0f0f0] px-4 py-4">
          <h3
            id="edit-member-title"
            className="text-[16px] font-semibold leading-[24px] text-[#0e0f11]"
          >
            Edit team member
          </h3>
          <button
            type="button"
            onClick={() => !saving && onClose()}
            aria-label="Close"
            className="grid h-8 w-8 place-items-center rounded-cta text-[#595959] transition-colors hover:bg-[#f5f5f5] hover:text-[#0e0f11]"
          >
            <svg
              aria-hidden
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-4 w-4"
            >
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {loading ? (
          <EditSkeleton />
        ) : (
          <form onSubmit={onSave}>
            <div className="flex flex-col gap-5 p-4">
              <Field label="Display name" htmlFor="member-name">
                <input
                  id="member-name"
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  className="h-11 w-full rounded-[12px] border border-[#f0f0f0] bg-white px-3.5 text-[16px] text-[#1f1f1f] outline-none transition-colors placeholder:text-[#747c88] focus:border-ink/25 focus:ring-2 focus:ring-ink/[0.06]"
                />
              </Field>

              <Field label="Primary email" htmlFor="member-email">
                <input
                  id="member-email"
                  type="email"
                  value={primaryEmail}
                  onChange={(e) => setPrimaryEmail(e.target.value)}
                  placeholder="alice@company.com"
                  className="h-11 w-full rounded-[12px] border border-[#f0f0f0] bg-white px-3.5 text-[16px] text-[#1f1f1f] outline-none transition-colors placeholder:text-[#747c88] focus:border-ink/25 focus:ring-2 focus:ring-ink/[0.06]"
                />
              </Field>

              <div>
                <span className="block text-[14px] font-medium text-[#595959]">
                  Kind
                </span>
                <div className="mt-2 flex flex-wrap gap-2">
                  {(
                    [
                      ["human", "Human"],
                      ["bot", "Bot"],
                      ["service_account", "Service"],
                    ] as const
                  ).map(([value, label]) => {
                    const active = kind === value;
                    return (
                      <button
                        key={value}
                        type="button"
                        onClick={() => setKind(value)}
                        aria-pressed={active}
                        className={`inline-flex h-10 items-center rounded-cta border px-3.5 text-[13px] font-medium transition-colors ${
                          active
                            ? "border-[#0e0f11] bg-[#0e0f11] text-white"
                            : "border-[#f0f0f0] bg-white text-[#1f1f1f] hover:border-ink/25"
                        }`}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {detail && detail.identities.length > 0 && (
                <div>
                  <span className="block text-[14px] font-medium text-[#595959]">
                    Linked identities
                  </span>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {detail.identities.map((i) => (
                      <span
                        key={`${i.provider}-${i.external_id}`}
                        className="inline-flex max-w-full items-center gap-2 rounded-[10px] bg-[#f9f9f9] px-2.5 py-1.5 text-[13px]"
                        title={i.external_email ?? undefined}
                      >
                        <ProviderLogo provider={i.provider} />
                        <span className="text-[#595959]">
                          {PROVIDER_LABEL[i.provider]}:
                        </span>
                        <span className="truncate font-medium text-[#0e0f11]">
                          {i.external_id}
                        </span>
                        {i.source === "admin" && (
                          <span className="shrink-0 rounded-[6px] bg-[#f5faf8] px-1.5 py-0.5 text-[11px] font-medium text-[#167f50]">
                            admin
                          </span>
                        )}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {}
            <div className="flex items-center justify-end gap-3 border-t border-[#f0f0f0] px-4 py-4">
              {error && (
                <span className="mr-auto text-[13px] text-[#cb2029]">{error}</span>
              )}
              <button
                type="button"
                onClick={onClose}
                disabled={saving}
                className="inline-flex h-10 items-center rounded-cta border border-[#f0f0f0] bg-white px-4 text-[16px] font-semibold text-[#1f1f1f] transition-colors hover:bg-[#fafafa] disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving}
                className="inline-flex h-10 items-center rounded-cta bg-[#0e0f11] px-4 text-[16px] font-semibold text-white transition-colors hover:bg-[#1f1f1f] disabled:opacity-50"
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label
        htmlFor={htmlFor}
        className="block text-[14px] font-medium text-[#595959]"
      >
        {label}
      </label>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

function ProviderLogo({ provider }: { provider: "github" | "jira" | "slack" }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span className="grid h-4 w-4 shrink-0 place-items-center rounded bg-white text-[8px] font-bold text-inkMuted">
        {PROVIDER_LABEL[provider].slice(0, 1)}
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={PROVIDER_LOGO[provider]}
      alt=""
      className="h-4 w-4 shrink-0 object-contain"
      onError={() => setFailed(true)}
    />
  );
}

function EditSkeleton() {
  return (
    <>
      <div className="flex flex-col gap-5 p-4">
        {[0, 1].map((i) => (
          <div key={i}>
            <div className="h-3 w-24 animate-pulse rounded bg-[#f0f0f0]" />
            <div className="mt-2 h-11 w-full animate-pulse rounded-[12px] bg-[#f0f0f0]" />
          </div>
        ))}
        <div>
          <div className="h-3 w-12 animate-pulse rounded bg-[#f0f0f0]" />
          <div className="mt-2 flex gap-2">
            <div className="h-9 w-20 animate-pulse rounded-[12px] bg-[#f0f0f0]" />
            <div className="h-9 w-16 animate-pulse rounded-[12px] bg-[#f0f0f0]" />
            <div className="h-9 w-20 animate-pulse rounded-[12px] bg-[#f0f0f0]" />
          </div>
        </div>
        <div>
          <div className="h-3 w-28 animate-pulse rounded bg-[#f0f0f0]" />
          <div className="mt-2 h-8 w-56 animate-pulse rounded-[10px] bg-[#f0f0f0]" />
        </div>
      </div>
      <div className="flex items-center justify-end gap-3 border-t border-[#f0f0f0] px-4 py-4">
        <div className="h-10 w-20 animate-pulse rounded-[12px] bg-[#f0f0f0]" />
        <div className="h-10 w-20 animate-pulse rounded-[12px] bg-[#f0f0f0]" />
      </div>
    </>
  );
}
