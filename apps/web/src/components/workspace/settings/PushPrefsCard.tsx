"use client";

import { useCallback, useEffect, useState } from "react";
import { BellOff, Bell, Check } from "lucide-react";

import { apiFetch } from "@/lib/api";
import { Skeleton } from "../Skeleton";
import { cx, FOCUS_RING } from "../layout/shared";

type PrefKey =
  | "slack_approval_push_enabled"
  | "autopilot_digest_push_enabled"
  | "slack_connector_alert_enabled"
  | "autopilot_digest_email_enabled"
  | "material_news_enabled"
  | "mention_alerts_enabled";

type Prefs = Partial<Record<PrefKey, boolean>>;

type Row = { key: PrefKey; label: string; help: string };
type Group = { surface: string; dest: string; rows: Row[]; quiet?: string };

const GROUPS: Group[] = [
  {
    surface: "Slack",
    dest: "#zavi",
    rows: [
      {
        key: "slack_approval_push_enabled",
        label: "Approvals",
        help: "When an agent needs your yes before it can carry on. They stay in Needs you either way; this only decides whether Slack is told.",
      },
      {
        key: "autopilot_digest_push_enabled",
        label: "Daily digest",
        help: "What your AI team did overnight, once each morning.",
      },
      {
        key: "slack_connector_alert_enabled",
        label: "Connector alerts",
        help: "A connection is expiring or broke. The connector tile shows the same thing when this is off.",
      },
    ],
  },
  {
    surface: "Email",
    dest: "the owner",
    rows: [
      {
        key: "autopilot_digest_email_enabled",
        label: "Daily digest",
        help: "The same morning brief, in your inbox.",
      },
      {
        key: "material_news_enabled",
        label: "Market moves",
        help: "Competitor and market news worth knowing about.",
      },
      {
        key: "mention_alerts_enabled",
        label: "Brand mentions",
        help: "Someone named you in a Reddit thread. Sent while the thread is still live, at most once a day.",
      },
    ],
  },
  {
    surface: "Telegram · Discord · WhatsApp · iMessage",
    dest: "replies only",
    rows: [],
    quiet:
      "Zavi pushes nothing to these. It answers messages you send it there, including a note when a run you started needs your approval.",
  },
];

export function PushPrefsCard() {
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [busy, setBusy] = useState<PrefKey | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch("/api/workspace/notification-prefs");
      if (!res.ok) throw new Error(String(res.status));
      const json = (await res.json()) as { prefs?: Prefs };
      setPrefs(json.prefs ?? {});
      setError(null);
    } catch {
      setPrefs(null);
      setError("Couldn't load your notification settings.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = useCallback(
    async (key: PrefKey, next: boolean) => {
      setBusy(key);
      const prev = prefs ?? {};
      setPrefs({ ...prev, [key]: next });
      try {
        const res = await apiFetch("/api/workspace/notification-prefs", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ [key]: next }),
        });
        if (!res.ok) throw new Error(String(res.status));
        const json = (await res.json()) as { prefs?: Prefs };
        setPrefs(json.prefs ?? { ...prev, [key]: next });
        setError(null);
      } catch {
        void (async () => {
          try {
            const res = await apiFetch("/api/workspace/notification-prefs");
            const json = (await res.json()) as { prefs?: Prefs };
            setPrefs(res.ok && json.prefs ? json.prefs : prev);
          } catch {
            setPrefs(prev);
          }
        })();
        setError("That didn't save. Try again.");
      } finally {
        setBusy(null);
      }
    },
    [prefs],
  );

  const onCount = prefs
    ? GROUPS.flatMap((g) => g.rows).filter((r) => prefs[r.key]).length
    : 0;
  const total = GROUPS.flatMap((g) => g.rows).length;

  return (
    <div className="rounded-block border border-[#f0f0f0] px-4 py-[19px]">
      <div className="flex items-start gap-3">
        {onCount === 0 ? (
          <BellOff className="mt-0.5 h-5 w-5 shrink-0 text-[#595959]" aria-hidden />
        ) : (
          <Bell className="mt-0.5 h-5 w-5 shrink-0 text-[#167f50]" aria-hidden />
        )}
        <div className="min-w-0 flex-1">
          <h3 className="text-[14px] font-semibold text-[#0e0f11]">
            When Zavi messages you
          </h3>
          <p className="mt-1 text-[13px] leading-[1.6] text-[#595959]">
            {prefs === null
              ? "Everything Zavi can send you unprompted, and its switch."
              : onCount === 0
                ? "Nothing is sent anywhere. Approvals and digests wait for you here in the app."
                : `${onCount} of ${total} turned on. Everything else waits for you here in the app.`}
          </p>

          {error && (
            <p className="mt-3 rounded-xl bg-[#fdf6e7] px-3 py-2 text-[13px] text-[#7d5405]">
              {error}
            </p>
          )}

          {prefs === null && !error ? (
            <div className="mt-4 space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-2/3" />
            </div>
          ) : (
            <div className="mt-4 space-y-5">
              {GROUPS.map((g) => (
                <div key={g.surface}>
                  <div className="flex items-baseline justify-between gap-3 border-b border-[#f0f0f0] pb-2">
                    <span className="text-[12px] font-semibold uppercase tracking-[0.05em] text-[#3d3d40]">
                      {g.surface}
                    </span>
                    <span className="shrink-0 font-mono text-[11px] text-[#8a8a86]">
                      {g.dest}
                    </span>
                  </div>

                  {g.rows.length === 0 ? (
                    <p className="pt-2.5 text-[13px] leading-[1.55] text-[#8a8a86]">
                      {g.quiet}
                    </p>
                  ) : (
                    <ul>
                      {g.rows.map((r) => {
                        const on = !!prefs?.[r.key];
                        return (
                          <li
                            key={r.key}
                            className="flex items-center gap-3 border-b border-[#f0f0f0] py-2.5 last:border-b-0"
                          >
                            <div className="min-w-0 flex-1">
                              <div className="text-[16px] font-semibold text-[#0e0f11]">
                                {r.label}
                              </div>
                              <div className="mt-0.5 text-[12px] leading-[1.45] text-[#8a8a86]">
                                {r.help}
                              </div>
                            </div>
                            <button
                              type="button"
                              role="switch"
                              aria-checked={on}
                              aria-label={`${g.surface}: ${r.label}`}
                              disabled={busy === r.key}
                              onClick={() => void toggle(r.key, !on)}
                              className={cx(
                                "relative h-[26px] w-[44px] shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                                on ? "bg-ink" : "bg-ink/20",
                                FOCUS_RING,
                              )}
                            >
                              <span
                                aria-hidden
                                className={cx(
                                  "absolute top-[3px] flex h-5 w-5 items-center justify-center rounded-full bg-cream shadow-sm transition-all",
                                  on ? "left-[21px]" : "left-[3px]",
                                )}
                              >
                                {on ? <Check aria-hidden size={12} strokeWidth={2.5} className="text-ink" /> : null}
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
