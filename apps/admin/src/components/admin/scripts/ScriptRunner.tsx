"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchRun,
  runScript,
  ScriptApiError,
  type FieldMeta,
  type ScriptInfo,
  type ScriptRun,
} from "@/lib/scripts-api";

const POLL_MS = 3000;

type Values = Record<string, string | boolean>;

export function initialValues(fields: FieldMeta[]): Values {
  const v: Values = {};
  for (const f of fields) {
    if (f.type === "file") continue;
    v[f.name] = f.type === "boolean" ? f.default === true : f.default !== undefined ? String(f.default) : "";
  }
  return v;
}

export function argsFrom(fields: FieldMeta[], values: Values): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.type === "file") continue;
    const v = values[f.name];
    if (f.type === "boolean") out[f.name] = v === true;
    else if (typeof v === "string" && v.trim() !== "") out[f.name] = f.type === "number" ? Number(v) : v.trim();
  }
  return out;
}

export function ScriptRunner({
  script,
  runs,
  onRunsChanged,
}: {
  script: ScriptInfo;
  runs: ScriptRun[];
  onRunsChanged: () => void;
}) {
  const [values, setValues] = useState<Values>(() => initialValues(script.fields));
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [dry, setDry] = useState<{ key: string; result: unknown } | null>(null);
  const [applied, setApplied] = useState<unknown>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [expectedPhrase, setExpectedPhrase] = useState<string | null>(null);
  const [liveRun, setLiveRun] = useState<ScriptRun | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const needsFile = script.fields.some((f) => f.type === "file");
  const args = useMemo(() => argsFrom(script.fields, values), [script.fields, values]);
  const inputKey = JSON.stringify(args) + (file ? `|${file.name}|${file.size}|${file.lastModified}` : "");
  const dryMatches = dry?.key === inputKey;

  const fieldsRef = useRef(script.fields);
  fieldsRef.current = script.fields;
  useEffect(() => {
    setValues(initialValues(fieldsRef.current));
    setFile(null);
    setDry(null);
    setApplied(null);
    setErr(null);
    setLiveRun(null);
  }, [script.key]);

  const poll = useCallback(
    async (id: string) => {
      try {
        const run = await fetchRun(id);
        setLiveRun(run);
        if (run.status === "running") {
          pollRef.current = setTimeout(() => void poll(id), POLL_MS);
        } else {
          onRunsChanged();
        }
      } catch (e) {
        setErr((e as Error).message);
      }
    },
    [onRunsChanged],
  );

  useEffect(() => () => {
    if (pollRef.current) clearTimeout(pollRef.current);
  }, []);

  function watch(id: string) {
    if (pollRef.current) clearTimeout(pollRef.current);
    void poll(id);
  }

  async function doDryRun() {
    setErr(null);
    setApplied(null);
    setBusy(true);
    try {
      const res = await runScript(script.key, "dry_run", args, { file });
      setDry({ key: inputKey, result: res.result });
    } catch (e) {
      setDry(null);
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function openConfirm() {
    const phrase =
      (dry?.result as { confirm_phrase?: string } | undefined)?.confirm_phrase ?? script.confirm_hint ?? "APPLY";
    setExpectedPhrase(phrase);
    setConfirmText("");
    setConfirmOpen(true);
  }

  async function doApply() {
    setErr(null);
    setBusy(true);
    try {
      const previewToken = (dry?.result as { preview_token?: string } | undefined)?.preview_token;
      const res = await runScript(script.key, "apply", args, { file, confirm: confirmText.trim(), previewToken });
      setConfirmOpen(false);
      if (res.async && res.run_id) {
        watch(res.run_id);
      } else {
        setApplied(res.result ?? null);
      }
      onRunsChanged();
    } catch (e) {
      if (e instanceof ScriptApiError && e.code === "confirm_mismatch" && typeof e.detail.expected === "string") {
        setExpectedPhrase(e.detail.expected);
        setConfirmText("");
        setErr(`The list changed since the dry run. Type "${e.detail.expected}" to send to the current list.`);
      } else if (e instanceof ScriptApiError && e.code === "list_changed") {
        setConfirmOpen(false);
        setDry(null);
        setErr(e.message);
      } else if (e instanceof ScriptApiError && e.code === "already_running") {
        setConfirmOpen(false);
        setErr("This script is already running. Showing that run's progress.");
        if (typeof e.detail.run_id === "string") watch(e.detail.run_id);
      } else {
        setConfirmOpen(false);
        setErr((e as Error).message);
      }
    } finally {
      setBusy(false);
    }
  }

  const missingRequired = script.fields.some((f) =>
    f.type === "file" ? f.required && !file : f.required && !(typeof values[f.name] === "string" && (values[f.name] as string).trim()),
  );

  return (
    <div className="space-y-5">
      <div>
        <h2 className="font-display text-xl font-semibold text-slate-900">{script.label}</h2>
        <p className="mt-1 max-w-2xl text-sm text-slate-600">{script.description}</p>
      </div>

      <form
        className="space-y-3 rounded-xl border border-slate-200 bg-white p-4"
        onSubmit={(e) => {
          e.preventDefault();
          void doDryRun();
        }}
      >
        {script.fields.map((f) => (
          <label key={f.name} className="block">
            <span className="text-sm font-medium text-slate-700">
              {f.label}
              {f.required ? <span className="text-rose-600"> *</span> : null}
            </span>
            {f.type === "file" ? (
              <input
                type="file"
                accept={f.accept}
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="mt-1 block w-full text-sm"
              />
            ) : f.type === "boolean" ? (
              <input
                type="checkbox"
                checked={values[f.name] === true}
                onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.checked }))}
                className="ml-2 align-middle"
              />
            ) : (
              <input
                type={f.type === "number" ? "number" : "text"}
                value={String(values[f.name] ?? "")}
                placeholder={f.placeholder}
                onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
            )}
            {f.help && <span className="mt-0.5 block text-xs text-slate-500">{f.help}</span>}
          </label>
        ))}

        <div className="flex flex-wrap gap-2 pt-1">
          <button
            type="submit"
            disabled={busy || missingRequired}
            className="rounded-md bg-sky-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50 hover:bg-sky-800"
          >
            {busy && !confirmOpen ? "Running…" : script.applies ? "Dry Run" : "Run"}
          </button>
          {script.applies && (
            <button
              type="button"
              disabled={busy || !dryMatches || liveRun?.status === "running"}
              onClick={openConfirm}
              title={dryMatches ? "" : "Run a Dry Run with these inputs first"}
              className="rounded-md bg-rose-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50 hover:bg-rose-700"
            >
              Apply
            </button>
          )}
          {script.applies && !dryMatches && (
            <span className="self-center text-xs text-slate-500">Apply unlocks after a Dry Run with these inputs.</span>
          )}
        </div>
      </form>

      {err && <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{err}</div>}

      {liveRun && <RunProgress run={liveRun} />}
      {applied !== null && <ResultView scriptKey={script.key} result={applied} applied />}
      {dry && applied === null && !liveRun && <ResultView scriptKey={script.key} result={dry.result} />}

      {confirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" role="dialog" aria-modal>
          <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl">
            <h3 className="font-semibold text-slate-900">Confirm {script.label}</h3>
            {script.key === "creator-send" && (
              <p className="mt-2 text-sm text-slate-600">
                This emails real people, once each. Only EU/UK email domains are filtered out: the sheet has no country column.
              </p>
            )}
            <p className="mt-3 text-sm text-slate-700">
              Type <code className="font-mono font-semibold">{expectedPhrase}</code> to confirm.
            </p>
            <input
              autoFocus
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={expectedPhrase ?? ""}
              className="mt-2 w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-sm"
            />
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setConfirmOpen(false)} className="rounded-md border border-slate-300 px-4 py-2 text-sm">
                Cancel
              </button>
              <button
                type="button"
                disabled={busy || confirmText.trim() !== expectedPhrase}
                onClick={() => void doApply()}
                className="rounded-md bg-rose-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
              >
                {busy ? "Applying…" : "Apply"}
              </button>
            </div>
          </div>
        </div>
      )}

      <RecentRuns runs={runs} onWatch={watch} />
    </div>
  );
}

function num(v: unknown): number {
  return typeof v === "number" ? v : 0;
}

function RunProgress({ run }: { run: ScriptRun }) {
  const p = { ...(run.progress ?? {}), ...(run.summary ?? {}) } as Record<string, unknown>;
  const total = num(p.total);
  const attempted = num(p.attempted);
  const pct = total ? Math.round((attempted / total) * 100) : run.status === "done" ? 100 : 0;
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium text-slate-800">
          {run.status === "running" ? "Running…" : run.status === "done" ? "Done" : "Failed"}
        </span>
        <span className="text-slate-500">started {new Date(run.started_at).toLocaleTimeString()} by {run.run_by_email}</span>
      </div>
      {total > 0 && (
        <>
          <div className="mt-3 h-2 w-full rounded bg-slate-100">
            <div className="h-2 rounded bg-sky-600" style={{ width: `${pct}%` }} />
          </div>
          <div className="mt-2 text-sm text-slate-700">
            {num(p.sent)} sent · {num(p.rejected)} rejected · {num(p.unknown)} unknown · {num(p.changed) + num(p.render_skipped)} skipped ·{" "}
            {Math.max(0, total - attempted)} left
          </div>
        </>
      )}
      {typeof p.stopped === "string" && p.stopped && <p className="mt-2 text-sm text-amber-700">Stopped: {p.stopped}</p>}
      {run.error && <p className="mt-2 text-sm text-rose-700">{run.error}</p>}
      {run.status !== "running" && total === 0 && run.summary && <SummaryLine summary={run.summary} />}
    </div>
  );
}

function SummaryLine({ summary }: { summary: Record<string, unknown> }) {
  return (
    <div className="text-xs text-slate-600">
      {Object.entries(summary)
        .filter(([, v]) => v !== null && v !== undefined && v !== "")
        .map(([k, v]) => `${k.replace(/_/g, " ")}: ${String(v)}`)
        .join(" · ")}
    </div>
  );
}

function RecentRuns({ runs, onWatch }: { runs: ScriptRun[]; onWatch: (id: string) => void }) {
  if (!runs.length) return <p className="text-xs text-slate-500">No applied runs yet.</p>;
  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold text-slate-800">Recent runs</h3>
      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full text-left text-xs">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="px-3 py-2">When</th>
              <th className="px-3 py-2">By</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Args</th>
              <th className="px-3 py-2">Summary</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id} className="border-t border-slate-100 align-top">
                <td className="px-3 py-2 whitespace-nowrap">{new Date(r.started_at).toLocaleString()}</td>
                <td className="px-3 py-2">{r.run_by_email}</td>
                <td className="px-3 py-2">
                  {r.status === "running" ? (
                    <button type="button" className="text-sky-700 underline" onClick={() => onWatch(r.id)}>
                      running · watch
                    </button>
                  ) : (
                    <span className={r.status === "failed" ? "text-rose-700" : "text-emerald-700"}>{r.status}</span>
                  )}
                </td>
                <td className="px-3 py-2 text-slate-600">
                  {Object.entries(r.args ?? {})
                    .filter(([, v]) => v !== null && v !== false)
                    .map(([k, v]) => `${k}=${String(v)}`)
                    .join(" ")}
                </td>
                <td className="px-3 py-2">
                  {r.summary ? <SummaryLine summary={r.summary} /> : r.error ? <span className="text-rose-700">{r.error}</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Count({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="text-lg font-semibold text-slate-900">{String(value ?? 0)}</div>
    </div>
  );
}

function RowList({ title, rows }: { title: string; rows: { sheet_row: number | null; name: string; reason?: string }[] }) {
  if (!rows?.length) return null;
  return (
    <details className="rounded-lg border border-slate-200 bg-white p-3" open={rows.length <= 20}>
      <summary className="cursor-pointer text-sm font-medium text-slate-800">
        {title} ({rows.length})
      </summary>
      <ul className="mt-2 max-h-72 space-y-0.5 overflow-auto text-xs text-slate-700">
        {rows.map((r, i) => (
          <li key={`${r.sheet_row}-${i}`}>
            row {r.sheet_row ?? "?"} · {r.name}
            {r.reason ? <span className="text-slate-500"> ({r.reason})</span> : null}
          </li>
        ))}
      </ul>
    </details>
  );
}

function downloadCsv(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export function ResultView({ scriptKey, result, applied = false }: { scriptKey: string; result: unknown; applied?: boolean }) {
  const r = (result ?? {}) as Any;
  const heading = applied ? "Applied" : "Dry run: nothing was changed";

  if (scriptKey === "creator-upload") {
    const missingLines = String(r.missing_email_csv ?? "").trim().split("\n").length - 1;
    return (
      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-slate-800">{heading}</h3>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Count label="Rows in sheet" value={r.rows} />
          <Count label="With email" value={r.with_email} />
          <Count label="Invitable now" value={r.invitable_now} />
          <Count label="Already have an account" value={r.has_account_rows?.length} />
          <Count label={applied ? "New saved" : "Would add"} value={r.result?.inserted} />
          <Count label={applied ? "Refreshed" : "Would refresh"} value={r.result?.updated} />
          <Count label="Email conflicts (held)" value={r.result?.email_conflicts?.length} />
          <Count label="In a conversation" value={r.in_conversation} />
        </div>
        {r.holds && Object.keys(r.holds).length > 0 && (
          <p className="text-sm text-slate-700">
            Held:{" "}
            {Object.entries(r.holds as Record<string, number>)
              .map(([k, v]) => `${k.replace(/_/g, " ")} ${v}`)
              .join(" · ")}
          </p>
        )}
        {r.sheet?.errors?.length > 0 && (
          <RowList title="Sheet rows skipped" rows={(r.sheet.errors as Any[]).map((e) => ({ sheet_row: e.sheet_row, name: "", reason: e.reason }))} />
        )}
        {r.loaded && <RowList title={`Loading the first ${r.limit}`} rows={r.loaded} />}
        {missingLines > 0 && (
          <button
            type="button"
            onClick={() => downloadCsv("creators-missing-email.csv", r.missing_email_csv)}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50"
          >
            Download {missingLines} row(s) missing an email
          </button>
        )}
      </div>
    );
  }

  if (scriptKey === "creator-list") {
    return (
      <div className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <Count label="Total" value={r.total} />
          {Object.entries((r.by_label ?? {}) as Record<string, number>).map(([k, v]) => (
            <Count key={k} label={k} value={v} />
          ))}
        </div>
        <div className="max-h-[32rem] overflow-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-slate-50 text-slate-500">
              <tr>
                <th className="px-3 py-2">Row</th>
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Email</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Profiles</th>
              </tr>
            </thead>
            <tbody>
              {((r.rows ?? []) as Any[]).map((row, i) => (
                <tr key={i} className="border-t border-slate-100">
                  <td className="px-3 py-1.5">{row.sheet_row ?? "?"}</td>
                  <td className="px-3 py-1.5">{row.name}</td>
                  <td className="px-3 py-1.5">{row.email ?? (row.has_email ? "✓ (hidden)" : "none")}</td>
                  <td className="px-3 py-1.5">
                    {row.label}
                    {row.hold_reason ? ` (${row.hold_reason})` : ""}
                    {row.in_conversation ? " [in conversation]" : ""}
                  </td>
                  <td className="px-3 py-1.5 text-slate-500">{(row.profiles ?? []).join(" ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  if (scriptKey === "creator-send") {
    return (
      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-slate-800">{heading}</h3>
        {r.problems?.length > 0 ? (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
            <div className="font-medium">Apply will be refused until these are fixed:</div>
            <ul className="mt-1 list-disc pl-5">
              {(r.problems as string[]).map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        ) : (
          <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">Settings check passed.</div>
        )}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Count label="Would email" value={r.would_send?.length} />
          <Count label="Eligible in batch" value={r.eligible} />
          <Count label="Skipped" value={r.skipped?.length} />
        </div>
        {r.sender && (
          <p className="text-xs text-slate-600">
            From {r.sender.name} &lt;{r.sender.email}&gt;
            {r.sample ? ` · subject "${r.sample.subject}" · signup ${r.sample.signup_url} · unsubscribe ${r.sample.unsubscribe_url}` : ""}
          </p>
        )}
        <RowList title="Would email" rows={r.would_send ?? []} />
        <RowList title="Skipped" rows={r.skipped ?? []} />
      </div>
    );
  }

  return <pre className="overflow-auto rounded-lg bg-slate-50 p-3 text-xs">{JSON.stringify(result, null, 2)}</pre>;
}
