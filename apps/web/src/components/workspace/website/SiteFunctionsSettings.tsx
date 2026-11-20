"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { apiFetch } from "@/lib/api";
import { Skeleton } from "../Skeleton";

export type SecretRow = { name: string; updated_at: string };
export type RunSummary = { id: string; started_at: string; duration_ms: number | null; status: "ok" | "error" | "timeout" | "running"; http_status: number | null };
export type LogLine = { at: string; level: "info" | "warn" | "error"; message: string };
export type RunDetail = RunSummary & { log: LogLine[] };
export type SiteFunction = {
  name: string;
  kind: "http" | "webhook" | "schedule";
  url: string | null;
  cron: string | null;
  enabled: boolean | null;
  last_run: RunSummary | null;
};
export type SiteFunctionsPayload = {
  secrets: { secrets: SecretRow[]; required: string[] };
  functions: SiteFunction[];
};

type Load =
  | { phase: "loading" }
  | { phase: "ready"; data: SiteFunctionsPayload }
  | { phase: "error"; message: string };

export type SiteFunctionsSection = "secrets" | "functions" | "schedules";

export const SITE_FUNCTIONS_TIMEOUT_MS = 20_000;
export const SITE_FUNCTIONS_TIMEOUT_MESSAGE = "This is taking too long to load. Try again.";

export const SITE_SECTION_COPY: Record<SiteFunctionsSection, { title: string; intro: string }> = {
  secrets: {
    title: "Secrets",
    intro: "Private keys your site's server functions use, like your Stripe secret key. Add them here, never in the chat.",
  },
  functions: {
    title: "Functions",
    intro: "Code your site runs on the server, for things like payments and webhooks. Open one to see its recent runs and logs.",
  },
  schedules: {
    title: "Schedules",
    intro: "Jobs your site runs on a timer. Times are in UTC. Turn one off to pause it without changing your site.",
  },
};

export const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

const qs = (buildSessionId: string) => `build_session_id=${encodeURIComponent(buildSessionId)}`;

export function functionsErrorMessage(status: number, body: { error?: { code?: string; message?: string } } | null): string {
  const code = body?.error?.code;
  if (status === 403) return "Only workspace owners and admins can manage secrets and functions.";
  if (code === "functions_unavailable") return "Server functions aren't available yet. Try again later.";
  if (code === "not_a_site") return "Secrets and server functions are available on sites made with the new builder.";
  if (typeof body?.error?.message === "string" && body.error.message) return body.error.message;
  return "Something went wrong. Try again.";
}

async function readJson(res: Response): Promise<any> {
  return res.json().catch(() => null);
}

export function withDeadline(ms: number): { signal: AbortSignal; timedOut: () => boolean; dispose: () => void } {
  const ctrl = new AbortController();
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    ctrl.abort();
  }, ms);
  return {
    signal: ctrl.signal,
    timedOut: () => expired,
    dispose: () => {
      clearTimeout(timer);
      ctrl.abort();
    },
  };
}

export function useSiteFunctions(buildSessionId: string) {
  const [load, setLoad] = useState<Load>({ phase: "loading" });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const deadline = withDeadline(SITE_FUNCTIONS_TIMEOUT_MS);
    setLoad({ phase: "loading" });
    void (async () => {
      try {
        const res = await apiFetch(`/api/website/site-functions?${qs(buildSessionId)}`, { signal: deadline.signal });
        const body = await readJson(res);
        if (cancelled) return;
        if (deadline.timedOut()) setLoad({ phase: "error", message: SITE_FUNCTIONS_TIMEOUT_MESSAGE });
        else if (!res.ok) setLoad({ phase: "error", message: functionsErrorMessage(res.status, body) });
        else setLoad({ phase: "ready", data: body as SiteFunctionsPayload });
      } catch {
        if (!cancelled) {
          setLoad({
            phase: "error",
            message: deadline.timedOut() ? SITE_FUNCTIONS_TIMEOUT_MESSAGE : "We couldn't load this. Try again.",
          });
        }
      } finally {
        deadline.dispose();
      }
    })();
    return () => {
      cancelled = true;
      deadline.dispose();
    };
  }, [buildSessionId, nonce]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { load, reload };
}

function shortDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  return new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

const card = "rounded-xl border border-[#f0f0f0] bg-white";
const btn = "inline-flex h-8 items-center rounded-cta border border-[#e5e5e5] px-3 text-[13px] font-medium text-[#0e0f11] hover:bg-[#f9f9f9] disabled:opacity-50";
const btnPrimary = "inline-flex h-8 items-center rounded-cta bg-[#0e0f11] px-3 text-[13px] font-medium text-white hover:bg-[#2a2a2a] disabled:opacity-50";

function Shell({ title, intro, children }: { title: string; intro: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-4 p-6">
      <div>
        <h2 className="text-[16px] font-semibold text-[#0e0f11]">{title}</h2>
        <p className="mt-1 max-w-[560px] text-[13px] leading-[1.5] text-[#595959]">{intro}</p>
      </div>
      {children}
    </div>
  );
}

function Notice({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "error" }) {
  return (
    <div role={tone === "error" ? "alert" : undefined} className={`rounded-xl border p-4 text-[13px] ${tone === "error" ? "border-[#f5c2c0] bg-[#fdf3f2] text-[#a8332c]" : "border-[#f0f0f0] bg-[#f9f9f9] text-[#595959]"}`}>
      {children}
    </div>
  );
}

const SKELETON_ROW = "flex h-14 items-center gap-3 px-4";
const SKELETON_TEXT = "h-3.5";

function SkeletonRow({ section, index }: { section: SiteFunctionsSection; index: number }) {
  const delayMs = index * 120;
  if (section === "schedules") {
    return (
      <li data-skeleton-row className={SKELETON_ROW}>
        <Skeleton className={`${SKELETON_TEXT} w-32`} delayMs={delayMs} />
        <Skeleton className={`${SKELETON_TEXT} w-16`} delayMs={delayMs} />
        <Skeleton className={`${SKELETON_TEXT} w-24`} delayMs={delayMs} />
        <Skeleton className="ml-auto h-6 w-11 shrink-0" rounded="rounded-full" delayMs={delayMs} />
      </li>
    );
  }
  if (section === "functions") {
    return (
      <li data-skeleton-row className={SKELETON_ROW}>
        <Skeleton className={`${SKELETON_TEXT} w-36`} delayMs={delayMs} />
        <Skeleton className={`${SKELETON_TEXT} w-28`} delayMs={delayMs} />
        <Skeleton className={`${SKELETON_TEXT} w-24`} delayMs={delayMs} />
        <Skeleton className="ml-auto h-8 w-[118px] shrink-0" rounded="rounded-cta" delayMs={delayMs} />
      </li>
    );
  }
  return (
    <li data-skeleton-row className={SKELETON_ROW}>
      <Skeleton className={`${SKELETON_TEXT} w-40`} delayMs={delayMs} />
      <Skeleton className={`${SKELETON_TEXT} w-14`} delayMs={delayMs} />
      <Skeleton className={`${SKELETON_TEXT} w-24`} delayMs={delayMs} />
      <span className="ml-auto flex shrink-0 gap-2">
        <Skeleton className="h-8 w-[78px]" rounded="rounded-cta" delayMs={delayMs} />
        <Skeleton className="h-8 w-[68px]" rounded="rounded-cta" delayMs={delayMs} />
      </span>
    </li>
  );
}

export function SiteSectionSkeleton({ section, rows = 3 }: { section: SiteFunctionsSection; rows?: number }) {
  const copy = SITE_SECTION_COPY[section];
  return (
    <div role="status" aria-busy="true" aria-label={`Loading ${copy.title.toLowerCase()}`} data-section-skeleton={section}>
      <Shell title={copy.title} intro={copy.intro}>
        {section === "secrets" && (
          <div aria-hidden>
            <Skeleton className="h-8 w-[112px]" rounded="rounded-cta" />
          </div>
        )}
        <ul aria-hidden className={`${card} divide-y divide-[#f0f0f0]`}>
          {Array.from({ length: rows }).map((_, i) => (
            <SkeletonRow key={i} section={section} index={i} />
          ))}
        </ul>
      </Shell>
    </div>
  );
}

function RunsSkeleton() {
  return (
    <ol role="status" aria-busy="true" aria-label="Loading runs" className="flex flex-col gap-2">
      {[0, 1].map((i) => (
        <li key={i} data-skeleton-row className="rounded-lg border border-[#f0f0f0] p-3">
          <div className="flex items-center gap-3">
            <Skeleton className="h-3 w-32" delayMs={i * 120} />
            <Skeleton className="h-3 w-12" delayMs={i * 120} />
            <Skeleton className="h-3 w-20" delayMs={i * 120} />
          </div>
          <Skeleton className="mt-2 h-14 w-full" delayMs={i * 120} />
        </li>
      ))}
    </ol>
  );
}

export function SecretForm({
  buildSessionId,
  lockedName,
  suggestedName,
  onDone,
  onCancel,
}: {
  buildSessionId: string;
  lockedName?: string;
  suggestedName?: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(lockedName ?? suggestedName ?? "");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameOk = SECRET_NAME_RE.test(name) && !name.startsWith("ZAVI_");
  const submit = async () => {
    if (!nameOk || !value.trim() || busy) return;
    setBusy(true);
    setError(null);
    const sending = value;
    setValue("");
    try {
      const res = await apiFetch(`/api/website/site-secrets/${encodeURIComponent(name)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ build_session_id: buildSessionId, value: sending }),
      });
      if (!res.ok) {
        setError(functionsErrorMessage(res.status, await readJson(res)));
        return;
      }
      onDone();
    } catch {
      setError("We couldn't save it. Try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className={`${card} flex flex-col gap-3 p-4`}
      aria-label={lockedName ? `Replace ${lockedName}` : "Add a secret"}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label className="flex flex-col gap-1 text-[14px] font-medium text-[#454545]">
        Name
        <input
          value={name}
          disabled={!!lockedName}
          onChange={(e) => setName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"))}
          placeholder="STRIPE_SECRET_KEY"
          autoComplete="off"
          spellCheck={false}
          className="h-9 rounded-lg border border-[#e5e5e5] px-2.5 font-mono text-[13px] text-[#0e0f11] outline-none focus:border-[#bdbdbd] disabled:bg-[#f9f9f9]"
        />
      </label>
      {name && !nameOk && (
        <p className="text-[12px] text-[#a8332c]">Use capital letters, digits and underscores, starting with a letter.</p>
      )}
      <label className="flex flex-col gap-1 text-[14px] font-medium text-[#454545]">
        Value
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoComplete="new-password"
          spellCheck={false}
          data-secret-input
          placeholder={lockedName ? "Paste the new value" : "Paste the value"}
          className="h-9 rounded-lg border border-[#e5e5e5] px-2.5 font-mono text-[13px] text-[#0e0f11] outline-none focus:border-[#bdbdbd]"
        />
      </label>
      <p className="text-[12px] text-[#8c8c8c]">Stored privately. Nobody can see it again, including you; replace it to change it.</p>
      {error && <p role="alert" className="text-[12px] text-[#a8332c]">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" className={btnPrimary} disabled={!nameOk || !value.trim() || busy}>
          {busy ? "Saving…" : lockedName ? "Replace" : "Save"}
        </button>
        <button type="button" className={btn} onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function SecretsPanel({ buildSessionId, data, onChanged }: { buildSessionId: string; data: SiteFunctionsPayload; onChanged: () => void }) {
  const [form, setForm] = useState<{ locked?: string; suggested?: string } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const saved = data.secrets.secrets;
  const savedNames = new Set(saved.map((s) => s.name));
  const missing = data.secrets.required.filter((n) => !savedNames.has(n));

  const remove = async (name: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/website/site-secrets/${encodeURIComponent(name)}?${qs(buildSessionId)}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) {
        setError(functionsErrorMessage(res.status, await readJson(res)));
        return;
      }
      setConfirming(null);
      onChanged();
    } catch {
      setError("We couldn't delete it. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell title={SITE_SECTION_COPY.secrets.title} intro={SITE_SECTION_COPY.secrets.intro}>
      {missing.length > 0 && (
        <Notice>
          <p className="font-medium text-[#0e0f11]">Your site needs {missing.length === 1 ? "this secret" : "these secrets"} to work:</p>
          <ul className="mt-2 flex flex-wrap gap-2">
            {missing.map((n) => (
              <li key={n}>
                <button type="button" className={btn} onClick={() => setForm({ suggested: n })}>
                  Add <span className="ml-1 font-mono">{n}</span>
                </button>
              </li>
            ))}
          </ul>
        </Notice>
      )}
      {form ? (
        <SecretForm
          key={form.locked ?? form.suggested ?? "new"}
          buildSessionId={buildSessionId}
          lockedName={form.locked}
          suggestedName={form.suggested}
          onCancel={() => setForm(null)}
          onDone={() => {
            setForm(null);
            onChanged();
          }}
        />
      ) : (
        <div>
          <button type="button" className={btnPrimary} onClick={() => setForm({})}>
            Add a secret
          </button>
        </div>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      {saved.length === 0 ? (
        <p className="text-[13px] text-[#8c8c8c]">No secrets saved yet.</p>
      ) : (
        <ul className={`${card} divide-y divide-[#f0f0f0]`} aria-label="Saved secrets">
          {saved.map((s) => (
            <li key={s.name} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <span className="font-mono text-[13px] text-[#0e0f11]">{s.name}</span>
              <span className="text-[12px] text-[#8c8c8c]" aria-label="value hidden">
                ••••••••
              </span>
              <span className="text-[12px] text-[#8c8c8c]">Updated {shortDate(s.updated_at)}</span>
              <span className="ml-auto flex gap-2">
                {confirming === s.name ? (
                  <>
                    <span className="self-center text-[13px] text-[#454545]">Delete it? Functions that use it will stop working.</span>
                    <button type="button" className={btn} disabled={busy} onClick={() => void remove(s.name)}>
                      Delete
                    </button>
                    <button type="button" className={btn} disabled={busy} onClick={() => setConfirming(null)}>
                      Keep
                    </button>
                  </>
                ) : (
                  <>
                    <button type="button" className={btn} onClick={() => setForm({ locked: s.name })}>
                      Replace
                    </button>
                    <button type="button" className={btn} onClick={() => setConfirming(s.name)}>
                      Delete
                    </button>
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Shell>
  );
}

const KIND_LABEL: Record<SiteFunction["kind"], string> = {
  http: "Called by your site",
  webhook: "Webhook",
  schedule: "Schedule",
};

const STATUS_LABEL: Record<RunSummary["status"], string> = {
  ok: "Worked",
  error: "Failed",
  timeout: "Took too long",
  running: "Running",
};

function RunBadge({ run }: { run: RunSummary | null }) {
  if (!run) return <span className="text-[12px] text-[#8c8c8c]">Not run yet</span>;
  const bad = run.status === "error" || run.status === "timeout";
  return (
    <span className={`text-[12px] ${bad ? "text-[#a8332c]" : "text-[#3d7a46]"}`}>
      {STATUS_LABEL[run.status]} · {shortDate(run.started_at)}
    </span>
  );
}

function RunsList({ buildSessionId, name }: { buildSessionId: string; name: string }) {
  const [state, setState] = useState<{ phase: "loading" } | { phase: "ready"; runs: RunDetail[] } | { phase: "error"; message: string }>({ phase: "loading" });
  useEffect(() => {
    let cancelled = false;
    const deadline = withDeadline(SITE_FUNCTIONS_TIMEOUT_MS);
    void (async () => {
      try {
        const res = await apiFetch(`/api/website/site-functions/${encodeURIComponent(name)}/runs?${qs(buildSessionId)}&limit=20`, { signal: deadline.signal });
        const body = await readJson(res);
        if (cancelled) return;
        if (deadline.timedOut()) setState({ phase: "error", message: SITE_FUNCTIONS_TIMEOUT_MESSAGE });
        else if (!res.ok) setState({ phase: "error", message: functionsErrorMessage(res.status, body) });
        else setState({ phase: "ready", runs: (body?.runs ?? []) as RunDetail[] });
      } catch {
        if (!cancelled) setState({ phase: "error", message: deadline.timedOut() ? SITE_FUNCTIONS_TIMEOUT_MESSAGE : "We couldn't load the runs." });
      } finally {
        deadline.dispose();
      }
    })();
    return () => {
      cancelled = true;
      deadline.dispose();
    };
  }, [buildSessionId, name]);
  if (state.phase === "loading") return <RunsSkeleton />;
  if (state.phase === "error") return <Notice tone="error">{state.message}</Notice>;
  if (state.runs.length === 0) return <p className="text-[13px] text-[#8c8c8c]">No runs yet.</p>;
  return (
    <ol className="flex flex-col gap-2" aria-label={`Recent runs of ${name}`}>
      {state.runs.map((r) => (
        <li key={r.id} className="rounded-lg border border-[#f0f0f0] p-3">
          <div className="flex flex-wrap gap-3 text-[12px] text-[#595959]">
            <RunBadge run={r} />
            {r.duration_ms !== null && <span>{r.duration_ms} ms</span>}
            {r.http_status !== null && <span>Answered {r.http_status}</span>}
          </div>
          {r.log.length > 0 && (
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[#f9f9f9] p-2 font-mono text-[12px] leading-[1.5] text-[#454545]">
              {r.log.map((l) => `${shortDate(l.at)}  ${l.level.toUpperCase()}  ${l.message}`).join("\n")}
            </pre>
          )}
        </li>
      ))}
    </ol>
  );
}

export function FunctionsPanel({ buildSessionId, data }: { buildSessionId: string; data: SiteFunctionsPayload }) {
  const [open, setOpen] = useState<string | null>(null);
  const fns = data.functions;
  return (
    <Shell title={SITE_SECTION_COPY.functions.title} intro={SITE_SECTION_COPY.functions.intro}>
      {fns.length === 0 ? (
        <Notice>Your site has no server functions yet. Ask Zavi to add payments, a webhook or a scheduled job and they will show up here.</Notice>
      ) : (
        <ul className={`${card} divide-y divide-[#f0f0f0]`} aria-label="Functions">
          {fns.map((f) => (
            <li key={f.name} className="px-4 py-3">
              <div className="flex flex-wrap items-center gap-3">
                <span className="font-mono text-[13px] text-[#0e0f11]">{f.name}</span>
                <span className="rounded-md bg-[#f4f4f4] px-1.5 py-0.5 text-[12px] text-[#595959]">{KIND_LABEL[f.kind]}</span>
                <RunBadge run={f.last_run} />
                <button
                  type="button"
                  className={`${btn} ml-auto`}
                  aria-expanded={open === f.name}
                  onClick={() => setOpen((o) => (o === f.name ? null : f.name))}
                >
                  {open === f.name ? "Hide runs" : "Runs and logs"}
                </button>
              </div>
              {f.kind === "webhook" && f.url && (
                <p className="mt-1.5 break-all text-[12px] text-[#595959]">
                  Webhook address: <span className="font-mono text-[#0e0f11]">{f.url}</span>
                </p>
              )}
              {open === f.name && (
                <div className="mt-3">
                  <RunsList buildSessionId={buildSessionId} name={f.name} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Shell>
  );
}

export function SchedulesPanel({ buildSessionId, data, onChanged }: { buildSessionId: string; data: SiteFunctionsPayload; onChanged: () => void }) {
  const schedules = data.functions.filter((f) => f.kind === "schedule");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toggle = async (f: SiteFunction) => {
    setPending(f.name);
    setError(null);
    try {
      const res = await apiFetch(`/api/website/site-schedules/${encodeURIComponent(f.name)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ build_session_id: buildSessionId, enabled: !(f.enabled ?? true) }),
      });
      if (!res.ok) {
        setError(functionsErrorMessage(res.status, await readJson(res)));
        return;
      }
      onChanged();
    } catch {
      setError("We couldn't change it. Try again.");
    } finally {
      setPending(null);
    }
  };
  return (
    <Shell title={SITE_SECTION_COPY.schedules.title} intro={SITE_SECTION_COPY.schedules.intro}>
      {error && <Notice tone="error">{error}</Notice>}
      {schedules.length === 0 ? (
        <Notice>Your site has no scheduled jobs.</Notice>
      ) : (
        <ul className={`${card} divide-y divide-[#f0f0f0]`} aria-label="Schedules">
          {schedules.map((f) => {
            const on = f.enabled !== false;
            return (
              <li key={f.name} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <span className="font-mono text-[13px] text-[#0e0f11]">{f.name}</span>
                <span className="font-mono text-[12px] text-[#595959]">{f.cron}</span>
                <RunBadge run={f.last_run} />
                <button
                  type="button"
                  role="switch"
                  aria-checked={on}
                  aria-label={`${on ? "Pause" : "Resume"} ${f.name}`}
                  disabled={pending === f.name}
                  onClick={() => void toggle(f)}
                  className={`ml-auto inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-50 ${on ? "bg-[#0e0f11]" : "bg-[#d9d9d9]"}`}
                >
                  <span className={`h-5 w-5 rounded-full bg-white shadow transition-transform ${on ? "translate-x-[22px]" : "translate-x-[2px]"}`} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Shell>
  );
}

export function SiteFunctionsSettings({ buildSessionId, section }: { buildSessionId: string; section: SiteFunctionsSection }) {
  const { load, reload } = useSiteFunctions(buildSessionId);
  if (load.phase === "loading") return <SiteSectionSkeleton section={section} />;
  if (load.phase === "error") {
    const copy = SITE_SECTION_COPY[section];
    return (
      <Shell title={copy.title} intro={copy.intro}>
        <Notice tone="error">
          <p>{load.message}</p>
          <button type="button" className={`${btn} mt-3`} onClick={reload}>
            Try again
          </button>
        </Notice>
      </Shell>
    );
  }
  if (section === "secrets") return <SecretsPanel buildSessionId={buildSessionId} data={load.data} onChanged={reload} />;
  if (section === "schedules") return <SchedulesPanel buildSessionId={buildSessionId} data={load.data} onChanged={reload} />;
  return <FunctionsPanel buildSessionId={buildSessionId} data={load.data} />;
}
