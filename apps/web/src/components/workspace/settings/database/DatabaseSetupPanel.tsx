"use client";

import { useState, type KeyboardEvent, type ReactNode } from "react";
import {
  FormField,
  FormNote,
  FormPanel,
  FormPrimaryButton,
  FormSecondaryButton,
  FormSecretInput,
  FormSelect,
} from "../formControls";
import { showConnectorError } from "../connectorErrorDialog";
import { probeFailureReason } from "@/app/connectors/OperatorDbConnectButton";
import { connectDb, type ConnectResult, type DbType, type ReadOnlyCheck } from "./databaseApi";
import { DB_LABEL, MONGO_NO_SCRIPT, REFUSED_NAME_NOTE, loginScript, type ScriptDb } from "./readOnlyScripts";

export type SetupMode = "cloud" | "connector";

export function OkRow({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-[14px] font-semibold text-[#0e0f11]">
      <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-[#f5faf8] text-[#167f50]">
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="m5 12.5 4.2 4.2L19 7" />
        </svg>
      </span>
      {children}
    </div>
  );
}

export function CodeBlock({ code, label }: { code: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    try {
      void navigator.clipboard?.writeText(code);
    } catch {
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };
  return (
    <div className="overflow-hidden rounded-[12px] bg-[#0e0f11]">
      <div className="flex items-center justify-between gap-2 border-b border-white/10 px-3.5 py-1.5">
        <span className="min-w-0 truncate text-[12px] text-white/70">{label}</span>
        <button
          type="button"
          onClick={copy}
          className="inline-flex h-7 shrink-0 cursor-pointer items-center rounded-md px-2 text-[12px] font-semibold text-white hover:bg-white/10"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto whitespace-pre-wrap break-words px-3.5 py-3 font-mono text-[12.5px] leading-[1.6] text-white">{code}</pre>
    </div>
  );
}

export function RefusedNames({ names }: { names: string[] }) {
  if (names.length === 0) return null;
  return (
    <p role="note" className="text-[12px] leading-[16px] text-amber-700">
      {REFUSED_NAME_NOTE}: {names.map((n) => JSON.stringify(n)).join(", ")}
    </p>
  );
}

export function hasLoginScript(dialect: string | null | undefined): dialect is ScriptDb {
  return dialect === "postgres" || dialect === "mysql";
}

export function readOnlyLine(check: ReadOnlyCheck | null | undefined, dialect?: string | null): string | null {
  if (check === "verified") return "Zavi checked this login's permissions: it can only read.";
  if (check === "can_write") return "This login can write. Zavi only reads, but a read-only login is recommended.";
  if (check === "unknown") {
    return dialect && !hasLoginScript(dialect)
      ? "Couldn't check automatically."
      : "Couldn't check automatically. Run the script below to make sure this login can only read.";
  }
  return null;
}

function ModeRow({
  title,
  chips,
  line,
  selected,
  onPick,
}: {
  title: string;
  chips: string[];
  line: string;
  selected: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onPick}
      className={`flex w-full cursor-pointer items-start gap-3 rounded-[12px] border bg-white px-3.5 py-3 text-left ${
        selected ? "border-[#0e0f11]" : "border-[#f0f0f0] hover:border-[#e0e0e0]"
      }`}
    >
      <span
        aria-hidden="true"
        className={`mt-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${selected ? "border-[#0e0f11]" : "border-[#bfbfbf]"}`}
      >
        {selected && <span className="h-2 w-2 rounded-full bg-[#0e0f11]" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-[15px] font-semibold text-[#0e0f11]">{title}</span>
          {chips.map((c) => (
            <span key={c} className="rounded-full bg-[#f0f0f0] px-2 py-0.5 text-[12px] font-medium text-[#1f1f1f]">
              {c}
            </span>
          ))}
        </span>
        <span className="mt-0.5 block text-[13px] leading-[18px] text-[#595959]">{line}</span>
      </span>
    </button>
  );
}

export function ChoosePanel({ onContinue, onCancel }: { onContinue: (mode: SetupMode) => void; onCancel: () => void }) {
  const [sel, setSel] = useState<SetupMode>("cloud");
  return (
    <FormPanel>
      <div className="flex flex-col gap-4">
        <p className="text-[16px] font-semibold text-[#0e0f11]">Connect your database</p>
        <div role="radiogroup" aria-label="Connect your database" className="flex flex-col gap-2">
          <ModeRow
            title="Quick setup"
            chips={["Recommended", "5 min"]}
            line="Paste a read-only login. Zavi keeps it encrypted."
            selected={sel === "cloud"}
            onPick={() => setSel("cloud")}
          />
          <ModeRow
            title="Keep data on your server"
            chips={["15 min"]}
            line="Install a small Zavi app. Your password never leaves your server."
            selected={sel === "connector"}
            onPick={() => setSel("connector")}
          />
        </div>
        <FormNote>Zavi only reads, never changes anything. Free on every plan.</FormNote>
        <div className="flex items-center gap-2.5">
          <FormPrimaryButton type="button" onClick={() => onContinue(sel)}>
            Continue
          </FormPrimaryButton>
          <FormSecondaryButton onClick={onCancel}>Cancel</FormSecondaryButton>
        </div>
      </div>
    </FormPanel>
  );
}

function ChipInput({
  label,
  values,
  onChange,
  placeholder,
}: {
  label: string;
  values: string[];
  onChange: (v: string[]) => void;
  placeholder: string;
}) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const v = draft.trim().replace(/,$/, "");
    if (v && !values.includes(v)) onChange([...values, v]);
    setDraft("");
  };
  return (
    <FormField label={label}>
      <div className="flex min-h-10 flex-wrap items-center gap-1.5 rounded-[10px] border border-[#f0f0f0] bg-white p-1.5">
        {values.map((v) => (
          <span key={v} className="inline-flex items-center gap-1 rounded-[8px] bg-[#f0f0f0] py-1 pl-2 pr-1 text-[13px] font-medium text-[#1f1f1f]">
            {v}
            <button
              type="button"
              aria-label={`Remove ${v}`}
              onClick={() => onChange(values.filter((x) => x !== v))}
              className="cursor-pointer rounded px-1 text-[#595959] hover:bg-[#e0e0e0]"
            >
              ×
            </button>
          </span>
        ))}
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              add();
            }
          }}
          onBlur={add}
          placeholder={placeholder}
          className="h-7 min-w-[140px] flex-1 px-1.5 text-[15px] text-[#1f1f1f] placeholder:text-[#bfbfbf] focus:outline-none"
        />
      </div>
    </FormField>
  );
}

export function ScriptBox({ initialDb = "postgres" }: { initialDb?: ScriptDb }) {
  const [db, setDb] = useState<ScriptDb>(initialDb);
  const [mode, setMode] = useState<"all" | "pick">("all");
  const [tables, setTables] = useState<string[]>([]);
  const unit = "table";
  const { script, refused } = loginScript(db, "", mode, tables);
  return (
    <div data-testid="read-only-script" className="grid gap-4 rounded-[12px] border border-[#f0f0f0] bg-[#f9f9f9] p-3.5">
      <p className="text-[13px] leading-[18px] text-[#595959]">
        Run this in your database to make a separate login for Zavi that can look at data but never change or delete
        anything. Then paste its connection string above.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Database">
          <FormSelect value={db} onChange={(e) => setDb(e.target.value as ScriptDb)} aria-label="Database">
            {(["postgres", "mysql"] as ScriptDb[]).map((d) => (
              <option key={d} value={d}>
                {DB_LABEL[d]}
              </option>
            ))}
          </FormSelect>
        </FormField>
        <FormField label="Zavi can read">
          <FormSelect value={mode} onChange={(e) => setMode(e.target.value as "all" | "pick")} aria-label="Zavi can read">
            <option value="all">Every {unit}</option>
            <option value="pick">Only the {unit}s I list</option>
          </FormSelect>
        </FormField>
      </div>
      {mode === "pick" && (
        <ChipInput
          label="Tables Zavi may read (type a name, press Enter)"
          values={tables}
          onChange={setTables}
          placeholder="e.g. subscriptions"
        />
      )}
      <CodeBlock code={script} label={`Run this in your ${DB_LABEL[db]} database`} />
      <RefusedNames names={refused} />
      <span className="-mt-2 text-[12px] leading-[16px] text-[#8a8a8a]">Zavi never sees your admin password.</span>
    </div>
  );
}

export function PasteForm({
  onCancel,
  onConnected,
  onNext,
}: {
  onCancel: () => void;
  onConnected?: (r: ConnectResult) => void;
  onNext: (r: ConnectResult) => void;
}) {
  const [type, setType] = useState<DbType>("postgres");
  const [connectionString, setConnectionString] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [scriptOpen, setScriptOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ConnectResult | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setResult(null);
    setBusy(true);
    try {
      const body = await connectDb(type, connectionString);
      setResult(body);
      if (body.ok) {
        setConnectionString("");
        onConnected?.(body);
      }
    } catch (err) {
      showConnectorError({ title: "Couldn’t save", message: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  if (result?.ok) {
    const line = readOnlyLine(result.read_only_check, type);
    return (
      <FormPanel>
        <div className="flex flex-col gap-2">
          <OkRow>Connected. Credentials verified.</OkRow>
          {line && (
            <p className={`text-[16px] leading-[22px] ${result.read_only_check === "can_write" ? "text-amber-700" : "text-[#595959]"}`}>{line}</p>
          )}
          <p className="text-[16px] leading-[22px] text-[#595959]">Next, check what Zavi can see.</p>
          <div className="mt-1">
            <FormPrimaryButton type="button" onClick={() => onNext(result)}>
              Next
            </FormPrimaryButton>
          </div>
        </div>
      </FormPanel>
    );
  }

  if (result && result.ok === false) {
    const reason = probeFailureReason(result.discovery_error);
    return (
      <FormPanel>
        <div className="flex flex-col gap-2.5">
          <div className="text-[14px] font-semibold text-[#0e0f11]">Couldn&apos;t connect to your database</div>
          <div className="rounded-[10px] border border-rose-200 bg-rose-50 px-3 py-2 text-[13px] leading-[17px] text-rose-700">
            {reason ? `${reason} ` : ""}Check the host, port and credentials, then try again. Nothing was saved.
          </div>
          <div className="flex items-center gap-2.5">
            <FormPrimaryButton type="button" onClick={() => setResult(null)}>
              Try again
            </FormPrimaryButton>
            <FormSecondaryButton onClick={onCancel}>Close</FormSecondaryButton>
          </div>
        </div>
      </FormPanel>
    );
  }

  return (
    <FormPanel onSubmit={onSubmit}>
      <div className="grid gap-4">
        <FormField label="DB type">
          <FormSelect value={type} onChange={(e) => setType(e.target.value as DbType)} aria-label="DB type">
            <option value="postgres">Postgres</option>
            <option value="mongodb">MongoDB</option>
            <option value="mysql">MySQL</option>
            <option value="dynamodb">DynamoDB</option>
          </FormSelect>
        </FormField>
        <FormField
          label="Connection string"
          hint={
            <>
              Stored encrypted in Vault. Never logged. Use a <strong className="font-semibold text-[#595959]">read-only</strong> DB user.
              Zavi only reads; write-capable connections may be flagged.
            </>
          }
        >
          <FormSecretInput
            show={showSecret}
            onToggle={() => setShowSecret((v) => !v)}
            value={connectionString}
            onChange={(e) => setConnectionString(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            required
            minLength={8}
            aria-label="Connection string"
            placeholder={
              type === "postgres"
                ? "postgres://user:pass@host:5432/db"
                : type === "mongodb"
                  ? "mongodb://user:pass@host:27017/db"
                  : type === "mysql"
                    ? "mysql://user:pass@host:3306/db"
                    : "dynamodb://access_key:secret_key@us-east-1"
            }
          />
        </FormField>
        {hasLoginScript(type) && (
          <div className="-mt-2">
            <button
              type="button"
              aria-expanded={scriptOpen}
              onClick={() => setScriptOpen((v) => !v)}
              className="cursor-pointer text-[13px] font-medium text-[#0e0f11] underline underline-offset-2"
            >
              Don&apos;t have a read-only login? We&apos;ll write the script.
            </button>
          </div>
        )}
        {scriptOpen && hasLoginScript(type) && <ScriptBox key={type} initialDb={type} />}
        {type === "mongodb" && <p className="-mt-2 text-[12px] leading-[16px] text-[#8a8a8a]">{MONGO_NO_SCRIPT}</p>}
        <FormNote>
          No setup needed. Zavi reads your tables automatically. Some features may ask you to confirm a few fields, like
          where bookings live.
        </FormNote>
        <div className="flex items-center gap-2.5">
          <FormPrimaryButton disabled={busy}>{busy ? "Detecting schema…" : "Connect & detect schema"}</FormPrimaryButton>
          <FormSecondaryButton onClick={onCancel} disabled={busy}>
            Cancel
          </FormSecondaryButton>
        </div>
      </div>
    </FormPanel>
  );
}
