"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Switch } from "@/components/ui/Switch";
import { FormPanel, FormPrimaryButton, FormSecondaryButton } from "../formControls";
import { showConnectorError } from "../connectorErrorDialog";
import { ApiError, getVisibility, putVisibility, type DbVisibility, type ReadOnlyCheck } from "./databaseApi";
import { CodeBlock, RefusedNames, hasLoginScript, readOnlyLine } from "./DatabaseSetupPanel";
import { MONGO_NO_SCRIPT, loginScript, removeScript } from "./readOnlyScripts";
import { unencryptedWarning } from "./databaseTile";

const POLL_MS = 3_000;
const POLL_LIMIT_MS = 120_000;

export function visibilityBody(
  view: Pick<DbVisibility, "tables" | "sensitive" | "hidden_fields" | "catalog_hash">,
  hidden: Record<string, boolean>,
  on: Record<string, boolean>,
): { catalog_hash: string; disabled_tables: string[]; hidden_fields: string[]; unhidden_fields: string[] } {
  const listed = new Set(view.sensitive.map((s) => `${s.table}.${s.field}`));
  const hiddenNow = view.sensitive.map((s) => `${s.table}.${s.field}`).filter((k) => hidden[k]);
  const keep = view.hidden_fields.filter((e) => !listed.has(e));
  return {
    catalog_hash: view.catalog_hash ?? "",
    disabled_tables: view.tables.filter((t) => !t.view_of && !on[t.name]).map((t) => t.name),
    hidden_fields: [...keep, ...hiddenNow],
    unhidden_fields: view.sensitive.map((s) => `${s.table}.${s.field}`).filter((k) => !hidden[k]),
  };
}

export function rescanNote(lastGoodScanAt: string | null | undefined): string {
  const d = lastGoodScanAt ? new Date(lastGoodScanAt) : null;
  const when = d && !Number.isNaN(d.getTime()) ? ` from ${d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}` : "";
  return `Zavi keeps the table list${when} below instead of dropping it, and checks again automatically. Tables added since then show up once a check finishes. If you changed your database login, reconnect it.`;
}

function Banner({ tone, title, children }: { tone: "ok" | "warning"; title: string; children?: React.ReactNode }) {
  const cls = tone === "ok" ? "border-[#cfe9dc] bg-[#f5faf8] text-[#167f50]" : "border-amber-200 bg-amber-50 text-amber-800";
  return (
    <div className={`rounded-[12px] border px-3.5 py-3 text-[13px] leading-[18px] ${cls}`}>
      <p className="font-semibold">{title}</p>
      {children && <div className="mt-1 text-[#595959]">{children}</div>}
    </div>
  );
}

function SubBox({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-[12px] border border-[#f0f0f0] px-3.5 py-3">
      <p className="text-[14px] font-semibold text-[#0e0f11]">{title}</p>
      {sub && <p className="mt-0.5 text-[13px] text-[#595959]">{sub}</p>}
      <div className="mt-2">{children}</div>
    </div>
  );
}

export function DatabaseSeePanel({
  readOnly,
  check = false,
  saveLabel = "Next",
  onSaved,
  onCancel,
}: {
  readOnly?: ReadOnlyCheck | null;
  check?: boolean;
  saveLabel?: string;
  onSaved: () => void;
  onCancel?: () => void;
}) {
  const [view, setView] = useState<DbVisibility | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Record<string, boolean>>({});
  const [on, setOn] = useState<Record<string, boolean>>({});
  const [stronger, setStronger] = useState(false);
  const [busy, setBusy] = useState(false);
  const started = useRef(Date.now());
  const checkedOnce = useRef(false);

  const load = useCallback(async () => {
    try {
      const v = await getVisibility(check && !checkedOnce.current);
      if (check) checkedOnce.current = true;
      setView((prev) => (prev && prev.read_only && !v.read_only ? { ...v, read_only: prev.read_only } : v));
      setHidden(Object.fromEntries(v.sensitive.map((s) => [`${s.table}.${s.field}`, s.hidden])));
      setOn(Object.fromEntries(v.tables.map((t) => [t.name, t.enabled])));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [check]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (view?.discovery !== "pending") return;
    if (Date.now() - started.current > POLL_LIMIT_MS) return;
    const t = window.setTimeout(() => void load(), POLL_MS);
    return () => window.clearTimeout(t);
  }, [view, load]);

  const save = async () => {
    if (!view) return;
    setBusy(true);
    try {
      await putVisibility(visibilityBody(view, hidden, on));
      onSaved();
    } catch (e) {
      showConnectorError({ title: "Couldn’t save", message: (e as Error).message });
      if (e instanceof ApiError && e.status === 409) void load();
    } finally {
      setBusy(false);
    }
  };

  const header = (
    <div>
      <p className="text-[16px] font-semibold text-[#0e0f11]">What Zavi can see</p>
      <p className="text-[13px] text-[#595959]">Zavi checked the login for your database. Here is what it found.</p>
    </div>
  );

  if (error && !view) {
    return (
      <FormPanel>
        <div className="flex flex-col gap-3">
          {header}
          <p className="text-[14px] text-rose-700">{error}</p>
          {onCancel && (
            <div>
              <FormSecondaryButton onClick={onCancel}>Close</FormSecondaryButton>
            </div>
          )}
        </div>
      </FormPanel>
    );
  }
  if (!view || view.discovery === "pending") {
    return (
      <FormPanel>
        <div className="flex flex-col gap-3">
          {header}
          <p className="text-[14px] text-[#595959]">Zavi is reading your tables. This takes about a minute.</p>
        </div>
      </FormPanel>
    );
  }
  if (view.discovery === "failed") {
    return (
      <FormPanel>
        <div className="flex flex-col gap-3">
          {header}
          <p className="text-[14px] text-rose-700">Database schema discovery did not complete. Reconnect the database to retry.</p>
          {onCancel && (
            <div>
              <FormSecondaryButton onClick={onCancel}>Close</FormSecondaryButton>
            </div>
          )}
        </div>
      </FormPanel>
    );
  }

  const mongo = view.dialect === "mongodb";
  const scripted = hasLoginScript(view.dialect);
  const ro = readOnly ?? view.read_only;
  const unencrypted = unencryptedWarning(view.dialect, view.transport);
  const line = readOnlyLine(ro, view.dialect);
  const colWord = mongo ? "fields" : "columns";
  const hiddenByTable = new Map<string, string[]>();
  for (const s of view.sensitive) {
    if (!hidden[`${s.table}.${s.field}`]) continue;
    hiddenByTable.set(s.table, [...(hiddenByTable.get(s.table) ?? []), s.field]);
  }
  const stronger_ = [...hiddenByTable].map(([table, cols]) =>
    removeScript(view.dialect, table, cols, view.tables.find((t) => t.name === table)?.columns ?? []),
  );
  const strongerScript = stronger_.map((r) => r.script).filter(Boolean).join("\n\n");
  const strongerRefused = stronger_.flatMap((r) => r.refused);
  const login = scripted ? loginScript(view.dialect as "postgres" | "mysql", "", "all", []) : null;

  return (
    <FormPanel>
      <div className="flex flex-col gap-4">
        {header}
        {view.last_rescan_failed_at && (
          <Banner tone="warning" title="Zavi’s latest check of your tables did not finish">
            {rescanNote(view.last_good_scan_at)}
          </Banner>
        )}
        {unencrypted && <Banner tone="warning" title={unencrypted.title}>{unencrypted.body}</Banner>}
        {ro === "verified" && line && <Banner tone="ok" title={line} />}
        {ro === "can_write" && line && (
          <Banner tone="warning" title={line}>
            Every Zavi query already runs read-only. A read-only login keeps it that way even if Zavi had a bug. Run this,
            then paste the new login.
            {login && (
              <div className="mt-2">
                <CodeBlock code={login.script} label="Create a read-only login" />
                <RefusedNames names={login.refused} />
              </div>
            )}
          </Banner>
        )}
        {ro === "unknown" && line && (
          <Banner tone="warning" title={line}>
            {login && (
              <div className="mt-1">
                <CodeBlock code={login.script} label="Create a read-only login" />
                <RefusedNames names={login.refused} />
              </div>
            )}
          </Banner>
        )}

        <SubBox title={`Sensitive-looking ${colWord}`} sub={`Zavi hid these for you. Zavi will not query a hidden ${mongo ? "field" : "column"}.`}>
          <ul className="divide-y divide-[#f0f0f0]">
            {view.sensitive.map((s) => {
              const k = `${s.table}.${s.field}`;
              return (
                <li key={k} className="flex items-center gap-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <code className="font-mono text-[13px] font-semibold text-[#0e0f11]">{k}</code>
                    <span className="ml-2 text-[12px] text-[#8c8c8c]">{s.kind}</span>
                    <p className="text-[12px] text-[#8c8c8c]">{hidden[k] ? "Hidden in Zavi. Your login can still read it." : "Zavi may use this."}</p>
                  </div>
                  <span className="text-[13px] font-medium text-[#1f1f1f]">{hidden[k] ? "Hidden" : "Un-hidden"}</span>
                  <Switch checked={Boolean(hidden[k])} onCheckedChange={(v) => setHidden((p) => ({ ...p, [k]: v }))} label={`Hidden: ${k}`} />
                </li>
              );
            })}
          </ul>
          {mongo && <p className="mt-2 text-[13px] text-[#595959]">{MONGO_NO_SCRIPT}</p>}
          {scripted && hiddenByTable.size > 0 && (
            <>
              <button
                type="button"
                onClick={() => setStronger((v) => !v)}
                aria-expanded={stronger}
                className="mt-2 inline-flex h-10 items-center justify-center rounded-cta border border-[#f0f0f0] bg-white px-4 text-[14px] font-semibold text-[#1f1f1f] hover:border-[#e0e0e0] hover:bg-[#fafafa]"
              >
                Make it stronger: remove these in your database
              </button>
              {stronger && (
                <div className="mt-2 space-y-2">
                  <p className="text-[13px] text-[#595959]">Then your login cannot read them at all, whatever Zavi does.</p>
                  {strongerScript && <CodeBlock code={strongerScript} label="Run this in your database" />}
                  <RefusedNames names={strongerRefused} />
                </div>
              )}
            </>
          )}
        </SubBox>

        <SubBox title={`${mongo ? "Collections" : "Tables"} Zavi may use`}>
          <ul className="divide-y divide-[#f0f0f0]">
            {view.tables.map((t) => (
              <li key={t.name} className="flex items-center gap-3 py-2 text-[13px]">
                <span className="min-w-0 flex-1 font-mono text-[13px] text-[#0e0f11]">
                  {t.name}
                  {t.view_of && <span className="ml-2 font-sans text-[12px] text-[#8c8c8c]">view of {t.view_of}</span>}
                </span>
                {t.rows != null && <span className="text-[#8c8c8c]">{t.rows.toLocaleString()} rows</span>}
                <Switch
                  checked={Boolean(on[t.name])}
                  disabled={Boolean(t.view_of)}
                  onCheckedChange={(v) => setOn((p) => ({ ...p, [t.name]: v }))}
                  label={`Zavi uses ${t.name}`}
                />
              </li>
            ))}
          </ul>
        </SubBox>

        <div className="flex items-center gap-2.5">
          <FormPrimaryButton type="button" onClick={() => void save()} disabled={busy}>
            {saveLabel}
          </FormPrimaryButton>
          {onCancel && <FormSecondaryButton onClick={onCancel}>Cancel</FormSecondaryButton>}
        </div>
      </div>
    </FormPanel>
  );
}
