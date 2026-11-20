"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Database, Upload, X } from "lucide-react";
import { Dialog } from "@/components/ui/Dialog";
import { confirmAction } from "@/components/ui/ConfirmDialog";
import { toast } from "@/components/ui/toast";
import { useAutoDismissMessage } from "./useAutoDismissMessage";
import { Skeleton } from "../Skeleton";
import { useWorkspaceOptional } from "../WorkspaceShell";
import { OPEN_DATABASE_IMPORT_EVENT, takeDatabaseImportRequest } from "./emailSettingsNav";
import {
  CONSENT_SENTENCE,
  addEmailSuppression,
  archiveContactList,
  confirmListConsent,
  eraseEmailContact,
  getArchivedContactLists,
  getContactLists,
  getEmailContacts,
  getEmailSuppressions,
  getImportColumns,
  getImportTables,
  getListSamples,
  importCsv,
  importDatabase,
  previewCsv,
  unarchiveContactList,
  type ArchivedContactList,
  type ContactCounts,
  type EmailBulkError,
  type ContactList,
  type CsvPreview,
  type ImportCounts,
  type ImportOutcome,
  isImportReceived,
  type ImportTable,
  type Person,
  type SuppressionPage,
} from "@/lib/workspace/emailBulkApi";
import { getEmailTestLists } from "@/lib/workspace/emailCampaignSettingsApi";
import { connectorSetupHref } from "../growth/growthPresentation";
import { EmailPager, pageRange, useSteadyHeight } from "./EmailPager";
import { EmailCheckbox } from "./EmailCheckbox";

const IMPORTED_SHOWN_MS = 3_000;
const FOCUS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30 focus-visible:ring-offset-1 focus-visible:ring-offset-cream";
const INPUT = `h-10 w-full min-w-0 rounded-[10px] border border-rule bg-cream px-3 text-[16px] leading-5 text-ink outline-none placeholder:text-inkLight focus:border-ink/40 disabled:cursor-not-allowed disabled:bg-creamDeep disabled:text-inkMuted sm:text-[14px] ${FOCUS}`;
const CHEVRON = "pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-inkMuted";
const BTN = `inline-flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-cta border border-rule bg-white px-3.5 text-[13px] font-medium text-ink cursor-pointer transition-colors hover:border-inkLight hover:bg-creamDeep disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS}`;
const BTN_PRIMARY = `inline-flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-cta border border-ink bg-ink px-4 text-[13px] font-medium text-cream cursor-pointer transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS}`;
const ICON_BTN = `inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-cta cursor-pointer text-inkMuted transition-colors hover:bg-creamDeep hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS}`;
const ROW_BTN = `inline-flex h-8 shrink-0 cursor-pointer items-center rounded-lg border border-rule bg-white px-2.5 text-[12px] font-medium text-danger transition-colors hover:border-inkLight hover:bg-creamDeep disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS}`;
const LABEL = "grid min-w-0 gap-1.5 text-[13px] font-medium text-ink";
const TABLE_WRAP = "overflow-x-auto rounded-xl border border-rule bg-white";
const WIDE_ONLY = "hidden sm:block";
const STACK_LIST = "divide-y divide-rule rounded-xl border border-rule bg-white sm:hidden";
const STACK_ROW = "grid min-w-0 gap-1 px-3 py-2.5 text-[13px] leading-5";
const STACK_META = "flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[12px] leading-[18px] text-inkMuted";
const TH = "px-3 py-2.5 text-left text-[12px] font-medium text-inkMuted";
const TD = "px-3 py-2.5 text-[13px] text-ink";
const EMPTY_CELL = "px-3 py-8 text-center text-[13px] text-inkMuted";
const SEGMENT =
  "inline-flex h-8 items-center gap-1.5 rounded-[8px] px-3.5 text-[13px] font-medium transition-colors duration-150 motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30";
const SEGMENT_ON = "bg-white text-ink shadow-[0_1px_2px_rgb(0_0_0/0.10),0_0_0_1px_rgb(var(--c-rule))]";
const SEGMENT_OFF = "text-inkMuted";
const NARROW_HIDE = "compact:hidden [@container(max-width:640px)]:hidden";
const CONNECT_DB_HREF = connectorSetupHref("operator_db");

const NEW_LIST = "__new__";
const PAGE = 10;
const n = (v: number) => v.toLocaleString("en-US");
const plural = (v: number, one: string, many: string) => `${n(v)} ${v === 1 ? one : many}`;
const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const sourceName = (source: Person["source"]) =>
  source === "database_and_csv" ? "Database and CSV" : source === "database" ? "Database" : "CSV";

type Field = "email" | "first" | "last" | "full" | "skip";
const FIELDS: Array<[Field, string]> = [
  ["email", "Email"],
  ["first", "First name"],
  ["last", "Last name"],
  ["full", "Full name"],
  ["skip", "Skip"],
];

const CLASHES: Partial<Record<Field, Field[]>> = { full: ["first", "last"], first: ["full"], last: ["full"] };

export function guessField(header: string): Field {
  const h = header.toLowerCase().replace(/[\s_-]+/g, " ").trim();
  if (/mail/.test(h)) return "email";
  if (/^(name|contact|contact name)$/.test(h) || /full ?name/.test(h)) return "full";
  if (/first/.test(h)) return "first";
  if (/last|surname/.test(h)) return "last";
  return "skip";
}

function initialMap(preview: CsvPreview): Field[] {
  const taken = new Set<Field>();
  const auto = preview.auto_column;
  const map = preview.columns.map((c) => {
    let f = auto ? (c.header === auto ? "email" : guessField(c.header)) : guessField(c.header);
    if (f === "email" && (!c.has_addresses || (auto && c.header !== auto))) f = "skip";
    if (f !== "skip" && taken.has(f)) f = "skip";
    if (f !== "skip") taken.add(f);
    return f;
  });
  return taken.has("full") && (taken.has("first") || taken.has("last")) ? map.map((f) => (f === "full" ? "skip" : f)) : map;
}

const STATUS: Record<string, [string, string]> = {
  ok: ["Subscribed", "bg-mintDeep/10 text-mintDeep"],
  unsubscribed: ["Unsubscribed", "bg-bone text-inkMuted"],
  bounced: ["Bounced", "bg-danger/10 text-danger"],
  complained: ["Marked as spam", "bg-danger/10 text-danger"],
  suppressed: ["Suppressed", "bg-bone text-inkMuted"],
  erased: ["Erased", "bg-bone text-inkMuted"],
};

const REASON: Record<string, string> = {
  unsubscribed: "Unsubscribed",
  unsubscribe: "Unsubscribed",
  bounced: "Bounced",
  bounce: "Bounced",
  complained: "Marked as spam",
  complaint: "Marked as spam",
  spam_report: "Marked as spam",
  manual: "Added by your team",
  erased: "Erased",
};

function Pill({ status }: { status: string }) {
  const [label, tone] = STATUS[status] ?? [status, "bg-bone text-inkMuted"];
  return <span className={`inline-flex shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[12px] font-medium ${tone}`}>{label}</span>;
}

function listCount(l: ContactList): number | null {
  if (l.members_hidden) return null;
  return l.active?.contact_count ?? l.latest?.contact_count ?? 0;
}

function importedLine(r: ImportOutcome, listName: string, countInvalid = false): string {
  if (isImportReceived(r)) return `Import received for ${listName}.`;
  const erased = r.skipped_erased ?? 0;
  const bad = countInvalid ? r.invalid : 0;
  const skipped = [
    bad > 0 ? `Skipped ${plural(bad, "row", "rows")} with no valid email.` : "",
    erased > 0 ? `Skipped ${plural(erased, "erased contact", "erased contacts")}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
  if (r.added === 0 && (erased > 0 || bad > 0)) return `${skipped} Nothing was imported into ${listName}.`;
  return `Imported ${plural(r.added, "contact", "contacts")} into ${listName}.${skipped && ` ${skipped}`}`;
}

async function recordConsent(r: ImportOutcome, canConsent: boolean): Promise<string> {
  if (!r.list_id || !r.version_id) return "";
  if (!canConsent) return " An owner or admin must confirm consent before Zavi can email them.";
  try {
    await confirmListConsent(r.list_id, r.version_id);
    return "";
  } catch (e) {
    return ` Consent was not saved: ${(e as Error).message} Confirm it under Lists.`;
  }
}

function Modal({ id, title, onClose, busy, children, footer }: {
  id: string;
  title: string;
  onClose: () => void;
  busy: boolean;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <Dialog id={id} label={title} onClose={onClose} busy={busy} className="workspace-shell text-ink">
      <div aria-hidden className="absolute inset-0 bg-black/40" onClick={() => !busy && onClose()} />
      <div className="absolute left-1/2 top-1/2 flex max-h-[calc(100dvh-2rem)] w-[640px] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl border border-rule bg-white shadow-pop">
        <div className="flex items-center justify-between gap-3 border-b border-rule py-3 pl-5 pr-3">
          <h3 className="text-[16px] font-semibold leading-6 text-ink">{title}</h3>
          <button type="button" aria-label="Close" disabled={busy} onClick={onClose} className={ICON_BTN}>
            <X aria-hidden className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 overflow-y-auto px-5 py-5">{children}</div>
        {footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-rule px-5 py-3">{footer}</div>}
      </div>
    </Dialog>
  );
}

function TargetPicker({ lists, target, setTarget, name, setName, idPrefix }: {
  lists: ContactList[];
  target: string;
  setTarget: (v: string) => void;
  name: string;
  setName: (v: string) => void;
  idPrefix: string;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <label className={LABEL} htmlFor={`${idPrefix}-list`}>
        Add to list
        <span className="relative block min-w-0">
          <select id={`${idPrefix}-list`} value={target} onChange={(e) => setTarget(e.target.value)} className={`${INPUT} appearance-none pr-9`}>
            {lists.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
            <option value={NEW_LIST}>New list…</option>
          </select>
          <ChevronDown aria-hidden className={CHEVRON} />
        </span>
      </label>
      {target === NEW_LIST && (
        <label className={LABEL} htmlFor={`${idPrefix}-name`}>
          New list name
          <input
            id={`${idPrefix}-name`}
            type="text"
            maxLength={120}
            placeholder="e.g. Waitlist"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={INPUT}
          />
        </label>
      )}
    </div>
  );
}

function ConsentTick({ checked, onChange, company, canConsent, id }: {
  checked: boolean;
  onChange: (v: boolean) => void;
  company: string;
  canConsent: boolean;
  id: string;
}) {
  return (
    <div className="mt-4">
      <label htmlFor={id} className="flex min-h-[44px] items-start gap-2.5 py-1 text-[14px] leading-5 text-ink">
        <EmailCheckbox id={id} checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5" />
        <span>These people agreed to get email from {company}</span>
      </label>
      {!canConsent && (
        <p className="pl-[26px] text-[12px] leading-[18px] text-inkMuted">An owner or admin must confirm this before Zavi can email them.</p>
      )}
    </div>
  );
}

function CsvDialog({ lists, startNew, canConsent, company, onClose, onImported }: {
  lists: ContactList[];
  startNew: boolean;
  canConsent: boolean;
  company: string;
  onClose: () => void;
  onImported: (message: string, needsReading: boolean) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [map, setMap] = useState<Field[]>([]);
  const [counts, setCounts] = useState<ImportCounts | null>(null);
  const [counting, setCounting] = useState(false);
  const [target, setTarget] = useState<string>(startNew || lists.length === 0 ? NEW_LIST : lists[0].id);
  const [name, setName] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState<"read" | "import" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const seq = useRef(0);
  const readSeq = useRef(0);

  const header = (f: Field) => {
    const i = map.indexOf(f);
    return i >= 0 && preview ? preview.columns[i].header : null;
  };
  const emailColumn = header("email");
  const intoList = target === NEW_LIST ? null : target;
  const firstColumn = header("first");
  const lastColumn = header("last");
  const fullColumn = header("full");

  const read = async (f: File | undefined) => {
    if (!f) return;
    const mine = ++readSeq.current;
    setBusy("read");
    setError(null);
    try {
      const p = await previewCsv(f);
      if (readSeq.current !== mine) return;
      setFile(f);
      setPreview(p);
      setMap(initialMap(p));
      setConsent(false);
    } catch (e) {
      if (readSeq.current === mine) setError((e as Error).message);
    } finally {
      if (readSeq.current === mine) setBusy(null);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  useEffect(() => {
    const mine = ++seq.current;
    setCounts(null);
    if (!file || !emailColumn) {
      setCounting(false);
      return;
    }
    setCounting(true);
    previewCsv(file, { column: emailColumn, firstColumn, lastColumn, fullColumn, listId: intoList })
      .then((p) => {
        if (seq.current !== mine) return;
        setCounts(p.counts ?? null);
        setError(null);
      })
      .catch((e: Error) => seq.current === mine && setError(e.message))
      .finally(() => seq.current === mine && setCounting(false));
  }, [file, emailColumn, firstColumn, lastColumn, fullColumn, intoList]);

  const setField = (index: number, f: Field) => {
    setMap((m) => m.map((v, i) => (i === index ? f : f !== "skip" && (v === f || CLASHES[f]?.includes(v)) ? "skip" : v)));
  };

  const toImport = counts ? (intoList ? counts.new : counts.new + counts.already_in_contacts + (counts.already_on_list ?? 0)) : 0;
  const skippedErased = counts?.skipped_erased ?? 0;
  const allOnList = !!counts && !!intoList && toImport === 0 && (counts.already_on_list ?? 0) > 0;
  const listName = target === NEW_LIST ? name.trim() : lists.find((l) => l.id === target)?.name ?? "";
  const ready = !!file && !!emailColumn && !!counts && !counting && toImport + skippedErased > 0 && consent && (target !== NEW_LIST || name.trim().length > 0);

  const run = async () => {
    if (!ready || !file || !emailColumn) return;
    setBusy("import");
    setError(null);
    try {
      const where = target === NEW_LIST ? { name: name.trim() } : { listId: target };
      const r = await importCsv({ file, column: emailColumn, firstColumn, lastColumn, fullColumn, ...where });
      const tail = await recordConsent(r, canConsent);
      onImported(`${importedLine(r, listName)}${tail}`, tail !== "");
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  };

  const rows = preview?.preview_rows ?? [];
  return (
    <Modal
      id="email-contacts-csv"
      title="Upload contacts"
      onClose={onClose}
      busy={busy === "import"}
      footer={
        preview && (
          <>
            <p role="status" className="mr-auto min-w-0 text-[12px] leading-[18px] text-inkMuted">
              {allOnList
                ? "Everyone in this file is already on this list."
                : counts && toImport + skippedErased > 0 && !consent
                  ? "Confirm these people agreed to get email."
                  : "Bad addresses and repeats are skipped."}
            </p>
            <button type="button" disabled={busy !== null} onClick={() => inputRef.current?.click()} className={BTN}>
              Choose another file
            </button>
            <button type="button" disabled={!ready || busy !== null} onClick={() => void run()} className={BTN_PRIMARY}>
              {busy === "import" ? "Importing…" : toImport > 0 ? `Import ${plural(toImport, "contact", "contacts")}` : "Import"}
            </button>
          </>
        )
      }
    >
      <input
        ref={inputRef}
        id="email-contacts-csv-file"
        type="file"
        accept=".csv,text/csv"
        className="sr-only"
        aria-label="CSV file"
        onChange={(e) => void read(e.target.files?.[0])}
      />
      {!preview ? (
        <label
          htmlFor="email-contacts-csv-file"
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            void read(e.dataTransfer.files?.[0]);
          }}
          className={`flex min-h-[180px] cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed px-4 py-8 text-center ${
            over ? "border-ink/40 bg-creamDeep" : "border-rule bg-bone"
          }`}
        >
          <Upload aria-hidden className="mb-1 h-5 w-5 text-inkMuted" />
          <span className="text-[14px] font-medium text-ink">{busy === "read" ? "Reading…" : "Drop a CSV here or choose a file"}</span>
          <span className="text-[12px] text-inkMuted">Needs an email column</span>
        </label>
      ) : (
        <div>
          <p className="flex flex-wrap gap-x-4 gap-y-1 rounded-[10px] bg-bone px-3 py-2.5 text-[13px] leading-5 text-ink">
            {emailColumn ? (
              counts ? (
                <>
                  <span className="font-semibold [overflow-wrap:anywhere]">{file?.name}</span>
                  <span>
                    <b>{n(counts.new)}</b> {counts.membership_hidden ? (counts.new === 1 ? "address" : "addresses") : "new"}
                  </span>
                  {(counts.already_on_list ?? 0) > 0 && (
                    <span>
                      <b>{n(counts.already_on_list ?? 0)}</b> already on this list
                    </span>
                  )}
                  {counts.already_in_contacts > 0 && (
                    <span>
                      <b>{n(counts.already_in_contacts)}</b> already in contacts
                    </span>
                  )}
                  {skippedErased > 0 && (
                    <span>
                      <b>{n(skippedErased)}</b> erased, will be skipped
                    </span>
                  )}
                  {counts.duplicate_in_file > 0 && (
                    <span>
                      <b>{n(counts.duplicate_in_file)}</b> {counts.duplicate_in_file === 1 ? "duplicate" : "duplicates"}
                    </span>
                  )}
                  {counts.bad > 0 && (
                    <span>
                      <b>{n(counts.bad)}</b> {counts.bad === 1 ? "bad address" : "bad addresses"}
                    </span>
                  )}
                  {counts.over_limit > 0 && <span>{n(counts.over_limit)} over the 10,000 limit</span>}
                </>
              ) : (
                <span className="text-inkMuted">Counting…</span>
              )
            ) : (
              <span className="text-danger">Pick the column that has the email address.</span>
            )}
          </p>
          <p className="mt-3 rounded-[10px] bg-marigold/15 px-3 py-2.5 text-[13px] leading-5 text-ink">
            Unsubscribes from other tools don't carry over. Remove those people from the file first, or add them under Suppressed.
          </p>
          <h4 className="mt-6 text-[14px] font-semibold text-ink">Match columns</h4>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            {preview.columns.map((c, i) => (
              <label key={`${c.header}-${i}`} htmlFor={`csv-map-${i}`} className={LABEL}>
                <span className="truncate">{c.header}</span>
                <span className="relative block min-w-0">
                  <select id={`csv-map-${i}`} value={map[i] ?? "skip"} onChange={(e) => setField(i, e.target.value as Field)} className={`${INPUT} appearance-none pr-9`}>
                    {FIELDS.map(([v, label]) => (
                      <option key={v} value={v} disabled={v === "email" && !c.has_addresses}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <ChevronDown aria-hidden className={CHEVRON} />
                </span>
              </label>
            ))}
          </div>
          {rows.length > 0 && (
            <div className={`mt-4 ${TABLE_WRAP}`}>
              <table className="w-full min-w-max border-collapse">
                <thead className="bg-bone">
                  <tr>
                    {preview.columns.map((c, i) => (
                      <th key={i} className={TH}>
                        {c.header}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-rule">
                  {rows.map((r, ri) => (
                    <tr key={ri}>
                      {preview.columns.map((_, ci) => (
                        <td key={ci} className={`${TD} max-w-[200px] truncate`}>
                          {r[ci] ?? ""}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="mt-6 border-t border-rule pt-5">
            <TargetPicker lists={lists} target={target} setTarget={setTarget} name={name} setName={setName} idPrefix="csv" />
          </div>
          <ConsentTick id="csv-consent" checked={consent} onChange={setConsent} company={company} canConsent={canConsent} />
        </div>
      )}
      {error && (
        <p role="alert" className="mt-3 text-[13px] leading-[18px] text-danger">
          {error}
        </p>
      )}
    </Modal>
  );
}

function DatabaseDialog({ lists, canConsent, company, onClose, onImported }: {
  lists: ContactList[];
  canConsent: boolean;
  company: string;
  onClose: () => void;
  onImported: (message: string, needsReading: boolean) => void;
}) {
  const [tables, setTables] = useState<ImportTable[] | null>(null);
  const [table, setTable] = useState("");
  const [columns, setColumns] = useState<Array<{ name: string; type: string }>>([]);
  const [column, setColumn] = useState("");
  const [target, setTarget] = useState<string>(lists.length === 0 ? NEW_LIST : lists[0].id);
  const [name, setName] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notConnected, setNotConnected] = useState(false);

  useEffect(() => {
    let live = true;
    getImportTables()
      .then((t) => {
        if (!live) return;
        if (t === null) setNotConnected(true);
        else if (t.length === 0) setError("We did not find any tables in your connected database.");
        setTables(t ?? []);
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, []);

  const tableSeq = useRef(0);
  const pickTable = async (t: string) => {
    const mine = ++tableSeq.current;
    setTable(t);
    setColumns([]);
    setColumn("");
    setConsent(false);
    setError(null);
    if (!t) return;
    try {
      const cols = await getImportColumns(t);
      if (tableSeq.current === mine) setColumns(cols);
    } catch (e) {
      if (tableSeq.current === mine) setError((e as Error).message);
    }
  };

  const pickColumn = (c: string) => {
    setColumn(c);
    setConsent(false);
    setError(null);
  };
  const pickTarget = (v: string) => {
    setTarget(v);
    setError(null);
  };

  const listName = target === NEW_LIST ? name.trim() : lists.find((l) => l.id === target)?.name ?? "";
  const ready = !!table && !!column && consent && (target !== NEW_LIST || name.trim().length > 0);
  const run = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const where = target === NEW_LIST ? { name: name.trim() } : { listId: target };
      const r = await importDatabase({ table, column, ...where });
      const tail = await recordConsent(r, canConsent);
      onImported(`${importedLine(r, listName, true)}${r.notice ? ` ${r.notice}` : ""}${tail}`, !!r.notice || tail !== "");
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal
      id="email-contacts-db"
      title="Import from database"
      onClose={onClose}
      busy={busy}
      footer={
        tables && tables.length > 0 && (
          <button type="button" disabled={!ready || busy} onClick={() => void run()} className={BTN_PRIMARY}>
            {busy ? "Importing…" : "Import"}
          </button>
        )
      }
    >
      <p className="text-[13px] leading-5 text-inkMuted">Zavi copies one column once, up to 5,000 rows. It never reads your database when it sends. Empty values and bad addresses are skipped.</p>
      {tables === null && !error && !notConnected && <Skeleton className="mt-3 h-10 w-full" />}
      {notConnected && (
        <div data-testid="email-contacts-db-empty" className="mt-4 grid justify-items-center gap-3 rounded-xl bg-bone px-4 py-6 text-center text-[13px] text-inkMuted">
          <p>No database connected yet.</p>
          <a href={CONNECT_DB_HREF} className={BTN}>
            Connect a database
          </a>
        </div>
      )}
      {tables && tables.length > 0 && (
        <div className="mt-4 grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className={LABEL} htmlFor="db-import-table">
              Table
              <span className="relative block min-w-0">
                <select id="db-import-table" value={table} onChange={(e) => void pickTable(e.target.value)} className={`${INPUT} appearance-none pr-9`}>
                  <option value="">Choose a table</option>
                  {tables.map((t) => (
                    <option key={t.name} value={t.name}>
                      {t.name}
                    </option>
                  ))}
                </select>
                <ChevronDown aria-hidden className={CHEVRON} />
              </span>
            </label>
            <label className={LABEL} htmlFor="db-import-column">
              Email column
              <span className="relative block min-w-0">
                <select id="db-import-column" value={column} disabled={columns.length === 0} onChange={(e) => pickColumn(e.target.value)} className={`${INPUT} appearance-none pr-9`}>
                  <option value="">Choose a column</option>
                  {columns.map((c) => (
                    <option key={c.name} value={c.name}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <ChevronDown aria-hidden className={CHEVRON} />
              </span>
            </label>
          </div>
          <TargetPicker lists={lists} target={target} setTarget={pickTarget} name={name} setName={setName} idPrefix="db" />
          <ConsentTick id="db-consent" checked={consent} onChange={setConsent} company={company} canConsent={canConsent} />
        </div>
      )}
      {error && (
        <p role="alert" className="mt-3 text-[13px] leading-[18px] text-danger">
          {error}
        </p>
      )}
    </Modal>
  );
}

function ListCard({ list, test, canConsent, onChanged, onError }: {
  list: ContactList;
  test: boolean;
  canConsent: boolean;
  onChanged: () => void;
  onError: (m: string | null) => void;
}) {
  const [busy, setBusy] = useState<"consent" | "archive" | null>(null);
  const total = listCount(list);
  const sendable = list.active?.sendable ?? null;

  const consent = async () => {
    const latest = list.latest;
    if (!latest) return;
    setBusy("consent");
    onError(null);
    try {
      const samples = await getListSamples(list.id);
      const count = latest.contact_count ?? samples.length;
      const more = Math.max(0, count - samples.length);
      const ok = await confirmAction({
        title: `Confirm consent for ${list.name}`,
        description: `${plural(count, "contact", "contacts")} from ${
          latest.mixed ? "your database and a CSV file" : latest.source_kind === "database" ? "your database" : "a CSV file"
        }${latest.source_label ? `, column ${latest.source_label}` : ""}.`,
        body: (
          <div className="grid gap-3">
            {samples.length > 0 && (
              <ul className="divide-y divide-rule rounded-xl border border-rule">
                {samples.map((e) => (
                  <li key={e} className="truncate px-3 py-2 text-[13px] text-ink">
                    {e}
                  </li>
                ))}
                {more > 0 && <li className="px-3 py-2 text-[12px] text-inkMuted">and {n(more)} more</li>}
              </ul>
            )}
            <p className="text-[14px] font-medium text-ink">{CONSENT_SENTENCE}</p>
          </div>
        ),
        confirmLabel: "Yes, they agreed",
      });
      if (!ok) return;
      await confirmListConsent(list.id, latest.id);
      onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const archive = async () => {
    const ok = await confirmAction({
      title: `Archive "${list.name}"?`,
      description: "Zavi will stop sending to it, including any send in progress. Unsubscribes are kept. You can bring it back from Archived lists.",
      confirmLabel: "Archive list",
      tone: "danger",
    });
    if (!ok) return;
    setBusy("archive");
    onError(null);
    try {
      await archiveContactList(list.id);
      onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <li className="flex min-w-0 flex-col gap-3 rounded-2xl border border-rule bg-white p-4">
      <div className="flex min-w-0 items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="flex min-w-0 items-center gap-2 text-[14px] font-semibold leading-5 text-ink">
            <span className="truncate">{list.name}</span>
            {test && <span className="shrink-0 rounded-full bg-bone px-2 py-0.5 text-[11px] font-medium text-inkMuted">Test</span>}
          </p>
          <p data-testid="list-card-count" className="mt-0.5 text-[13px] leading-5 tabular-nums text-inkMuted">
            {total === null ? (
              "Only an owner or admin can see who is on this list."
            ) : (
              <>
                <span className="font-medium text-ink">{n(total)}</span> {total === 1 ? "person" : "people"}
              </>
            )}
          </p>
        </div>
        {canConsent && (
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void archive()}
            className={`-mt-0.5 inline-flex h-8 shrink-0 cursor-pointer items-center rounded-lg border border-rule bg-white px-2.5 text-[12px] font-medium text-ink transition-colors hover:border-inkLight hover:bg-creamDeep disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS}`}
          >
            {busy === "archive" ? "Archiving…" : "Archive"}
            <span className="sr-only"> {list.name}</span>
          </button>
        )}
      </div>
      {list.needs_consent ? (
        <div className="grid gap-2 border-t border-rule pt-3">
          <span className="inline-flex items-center gap-1.5 text-[12px] text-ink">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-marigoldDeep" />
            Needs consent
          </span>
          {canConsent ? (
            <button type="button" disabled={busy !== null} onClick={() => void consent()} className={`${BTN_PRIMARY} justify-self-start`}>
              {busy === "consent" ? "Saving…" : "Confirm consent"}
              <span className="sr-only"> for {list.name}</span>
            </button>
          ) : (
            <p className="text-[12px] leading-[18px] text-inkMuted">An owner or admin must confirm consent for this list.</p>
          )}
        </div>
      ) : (
        sendable !== null && total !== null && sendable < total && <p className="border-t border-rule pt-3 text-[12px] leading-[18px] text-inkMuted">{`${n(sendable)} of ${n(total)} can be emailed`}</p>
      )}
    </li>
  );
}

function unarchivedLine(name: string, stoppedSends: number): string {
  const back = `${name} is back in Lists and can be picked for sending again.`;
  if (stoppedSends === 0) return back;
  return `${back} ${stoppedSends === 1 ? "The send the archive stopped stays" : `The ${n(stoppedSends)} sends the archive stopped stay`} stopped. To email this list, approve a new email.`;
}

function ArchivedListsDialog({ lists, canManage, onClose, onUnarchived }: {
  lists: ArchivedContactList[];
  canManage: boolean;
  onClose: () => void;
  onUnarchived: (message: string, needsAction: boolean) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const unarchive = async (list: ArchivedContactList) => {
    if (busy) return;
    const ok = await confirmAction({
      title: `Unarchive "${list.name}"?`,
      description: "It goes back to Lists and can be picked for sending again. Nothing is sent by itself: a send the archive stopped stays stopped. Unsubscribed, bounced and suppressed people stay off every send, and consent stays as it was.",
      confirmLabel: "Unarchive list",
    });
    if (!ok) return;
    setBusy(list.id);
    setError(null);
    try {
      const r = await unarchiveContactList(list.id);
      onUnarchived(r.unarchived ? unarchivedLine(list.name, r.stopped_sends) : `${list.name} is already in Lists.`, r.unarchived && r.stopped_sends > 0);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal id="email-archived-lists" title="Archived lists" onClose={onClose} busy={busy !== null}>
      <ul aria-label="Archived lists" className="divide-y divide-rule rounded-xl border border-rule">
        {lists.map((l) => (
          <li key={l.id} data-testid="archived-list-row" className="flex min-w-0 items-center gap-3 px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <p className="truncate text-[14px] font-medium leading-5 text-ink">{l.name}</p>
              <p className="text-[13px] leading-5 tabular-nums text-inkMuted">
                {l.people === null ? "Only an owner or admin can see who is on this list." : plural(l.people, "person", "people")}
              </p>
            </div>
            {canManage && (
              <button type="button" disabled={busy !== null} onClick={() => void unarchive(l)} className={BTN}>
                {busy === l.id ? "Unarchiving…" : "Unarchive"}
                <span className="sr-only"> {l.name}</span>
              </button>
            )}
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="mt-3 text-[13px] leading-[18px] text-danger">
          {error}
        </p>
      )}
    </Modal>
  );
}

function PeopleView({ lists, reloadKey, onCounts, canErase, onErased }: {
  lists: ContactList[];
  reloadKey: number;
  onCounts: (c: ContactCounts) => void;
  canErase: boolean;
  onErased: () => void;
}) {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [listId, setListId] = useState("");
  const [rows, setRows] = useState<Person[] | null>(null);
  const [total, setTotal] = useState(0);
  const [masked, setMasked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [loadedPage, setLoadedPage] = useState(1);
  const pickedHidden = !!listId && lists.some((l) => l.id === listId && l.members_hidden);
  const hiddenLists = listId ? pickedHidden : lists.some((l) => l.members_hidden);
  const emptyLine = pickedHidden ? "Only an owner or admin can see who is on this list." : "No one matches.";
  const [tick, setTick] = useState(0);
  const [erasing, setErasing] = useState<string | null>(null);
  const [eraseError, setEraseError] = useState<string | null>(null);
  const eraseGuard = useRef(false);
  const seq = useRef(0);
  const countsRef = useRef(onCounts);
  countsRef.current = onCounts;

  const refreshCounts = () => {
    getEmailContacts({ offset: 0, limit: 1 })
      .then((p) => {
        if (p.counts) countsRef.current(p.counts);
      })
      .catch(() => undefined);
  };

  const erase = async (p: Person) => {
    if (eraseGuard.current) return;
    eraseGuard.current = true;
    try {
      const who = p.name?.trim() || p.email;
      const ok = await confirmAction({
        title: `Erase ${who}?`,
        description: "This cannot be undone. They come off every list and Zavi will not email them again, even if the address is uploaded again. An email leaving at this very moment may still arrive. Campaigns sent through SendGrid, Mailchimp or Klaviyo follow that tool's own list, so remove them there too.",
        confirmLabel: "Erase",
        tone: "danger",
      });
      if (!ok) return;
      setErasing(p.id);
      setEraseError(null);
      await eraseEmailContact(p.id);
      toast.add({ type: "success", title: "Erased", position: "top-center", dismissible: false, timeout: IMPORTED_SHOWN_MS });
      onErased();
      if (query || page > 1) refreshCounts();
    } catch (e) {
      const failure = e as EmailBulkError;
      setEraseError(failure.message);
      if (failure.status === 404) {
        onErased();
        if (query || page > 1) refreshCounts();
      }
    } finally {
      setErasing(null);
      eraseGuard.current = false;
    }
  };

  useEffect(() => {
    if (search.trim() === query) return;
    const t = setTimeout(() => {
      setQuery(search.trim());
      setPage(1);
    }, 250);
    return () => clearTimeout(t);
  }, [search, query]);

  useEffect(() => {
    const mine = ++seq.current;
    setError(null);
    getEmailContacts({ search: query, listId: listId || undefined, offset: (page - 1) * PAGE, limit: PAGE })
      .then((p) => {
        if (seq.current !== mine) return;
        if (p.rows.length === 0 && page > 1) {
          setPage(Math.max(1, Math.min(page - 1, Math.ceil(p.total / PAGE))));
          return;
        }
        setRows(p.rows);
        setTotal(p.total);
        setMasked(p.masked);
        setLoadedPage(page);
        if (p.counts) countsRef.current(p.counts);
      })
      .catch((e: Error) => seq.current === mine && setError(e.message));
  }, [query, listId, reloadKey, page, tick]);

  const hasNext = loadedPage * PAGE < total;
  const first = (loadedPage - 1) * PAGE + 1;
  const last = (loadedPage - 1) * PAGE + (rows?.length ?? 0);

  const paging = !!rows && rows.length > 0 && (loadedPage > 1 || hasNext);
  const steady = useSteadyHeight(`${query}\u0000${listId}`, paging && page !== loadedPage);

  const named = (rows ?? []).some((p) => !!p.name?.trim());

  return (
    <div className="grid gap-3">
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          type="search"
          aria-label="Search contacts"
          placeholder="Search name or email"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className={`${INPUT} sm:flex-1`}
        />
        <div className="relative min-w-0 sm:w-56">
          <select
            aria-label="Filter by list"
            value={listId}
            onChange={(e) => {
              setListId(e.target.value);
              setPage(1);
            }}
            className={`${INPUT} appearance-none pr-9`}
          >
            <option value="">All lists</option>
            {lists.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
          <ChevronDown aria-hidden className={CHEVRON} />
        </div>
      </div>
      {hiddenLists && (
        <p data-testid="people-hidden-lists" className="text-[12px] leading-[18px] text-inkMuted">
          People on lists copied from your database are shown to owners and admins only.
        </p>
      )}
      {masked && !hiddenLists && (
        <p className="text-[12px] leading-[18px] text-inkMuted">Addresses copied from your database are partly hidden for your role. Search those people by name.</p>
      )}
      {error && (
        <p role="alert" className="flex flex-wrap items-center gap-2 text-[13px] text-danger">
          {error}
          <button type="button" onClick={() => setTick((v) => v + 1)} className={BTN}>
            Retry
          </button>
        </p>
      )}
      {eraseError && (
        <p role="alert" className="text-[13px] text-danger">
          {eraseError}
        </p>
      )}
      {rows === null && !error ? (
        <Skeleton className="h-5 w-[46%]" />
      ) : (
        rows && (
          <div ref={steady.ref} style={{ minHeight: steady.minHeight }} className="grid min-w-0 content-start">
          <ul aria-label="People" data-testid="contacts-people-stacked" className={STACK_LIST}>
            {rows.length === 0 ? (
              <li className={EMPTY_CELL}>{emptyLine}</li>
            ) : (
              rows.map((p) => (
                <li key={p.id} data-testid="contact-stacked-row" className={STACK_ROW}>
                  {p.name?.trim() && <p className="font-medium text-ink [overflow-wrap:anywhere]">{p.name}</p>}
                  <p className="text-ink [overflow-wrap:anywhere]">{p.email}</p>
                  <div className={STACK_META}>
                    <Pill status={p.status} />
                    {p.lists.length > 0 && <span className="[overflow-wrap:anywhere]">{p.lists.map((l) => l.name).join(", ")}</span>}
                    <span>{sourceName(p.source)}</span>
                    <span className="tabular-nums">Added {day(p.added_at)}</span>
                  </div>
                  {canErase && (
                    <button type="button" disabled={erasing !== null} onClick={() => void erase(p)} className={`${ROW_BTN} mt-1 h-10 justify-self-start px-3.5 text-[13px]`}>
                      {erasing === p.id ? "Erasing…" : "Erase"}
                      <span className="sr-only"> {p.name?.trim() || p.email}</span>
                    </button>
                  )}
                </li>
              ))
            )}
          </ul>
          <div className={`${TABLE_WRAP} ${WIDE_ONLY}`}>
            <table className={`w-full border-collapse ${named ? (canErase ? "min-w-[720px]" : "min-w-[640px]") : canErase ? "min-w-[620px]" : "min-w-[540px]"} compact:min-w-0 [@container(max-width:640px)]:min-w-0`}>
              <thead className="bg-bone">
                <tr>
                  {named && <th className={TH}>Name</th>}
                  <th className={TH}>Email</th>
                  <th className={TH}>Lists</th>
                  <th className={TH}>Status</th>
                  <th className={`${TH} ${NARROW_HIDE}`}>Source</th>
                  <th className={`${TH} text-right ${NARROW_HIDE}`}>Added</th>
                  {canErase && <th className={`${TH} sticky right-0 bg-bone`}><span className="sr-only">Actions</span></th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-rule">
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={(named ? 6 : 5) + (canErase ? 1 : 0)} className={EMPTY_CELL}>
                      {emptyLine}
                    </td>
                  </tr>
                ) : (
                  rows.map((p) => (
                    <tr key={p.id}>
                      {named && (
                        <td title={p.name?.trim() || undefined} className={`${TD} max-w-[180px] truncate whitespace-nowrap font-medium`}>
                          {p.name?.trim() || <span className="font-normal text-inkMuted">No name</span>}
                        </td>
                      )}
                      <td data-testid="contact-email" className={`${TD} whitespace-nowrap`}>{p.email}</td>
                      <td title={p.lists.map((l) => l.name).join(", ") || undefined} className={`${TD} max-w-[220px] truncate whitespace-nowrap text-inkMuted`}>
                        {p.lists.map((l) => l.name).join(", ")}
                      </td>
                      <td data-testid="contact-status" className={`${TD} whitespace-nowrap`}>
                        <Pill status={p.status} />
                      </td>
                      <td className={`${TD} whitespace-nowrap text-inkMuted ${NARROW_HIDE}`}>{sourceName(p.source)}</td>
                      <td className={`${TD} whitespace-nowrap text-right text-inkMuted ${NARROW_HIDE}`}>{day(p.added_at)}</td>
                      {canErase && (
                        <td className={`${TD} sticky right-0 bg-white whitespace-nowrap text-right`}>
                          <button type="button" disabled={erasing !== null} onClick={() => void erase(p)} className={ROW_BTN}>
                            {erasing === p.id ? "Erasing…" : "Erase"}
                            <span className="sr-only"> {p.name?.trim() || p.email}</span>
                          </button>
                        </td>
                      )}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          </div>
        )
      )}
      {paging && (
        <EmailPager
          label="People pages"
          testId="contacts-people-pager"
          rangeTestId="contacts-people-range"
          range={pageRange(first, last, total)}
          canPrev={loadedPage > 1 && page === loadedPage}
          canNext={hasNext && page === loadedPage}
          onPrev={() => setPage(loadedPage - 1)}
          onNext={() => setPage(loadedPage + 1)}
        />
      )}
    </div>
  );
}

function SuppressedView({ canEdit, onChanged }: { canEdit: boolean; onChanged: () => void }) {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<SuppressionPage | null>(null);
  const [loadedPage, setLoadedPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (search.trim() === query) return;
    const t = setTimeout(() => {
      setQuery(search.trim());
      setPage(1);
    }, 250);
    return () => clearTimeout(t);
  }, [search, query]);

  useEffect(() => {
    let live = true;
    setLoadError(null);
    getEmailSuppressions({ search: query, page })
      .then((r) => {
        if (!live) return;
        if (r.rows.length === 0 && page > 1) {
          setPage(Math.max(1, Math.min(page - 1, Math.ceil(r.total / r.page_size))));
          return;
        }
        setData(r);
        setLoadedPage(page);
      })
      .catch((e: Error) => live && setLoadError(e.message));
    return () => {
      live = false;
    };
  }, [query, page, tick]);

  const add = async () => {
    const email = draft.trim();
    if (!email || busy) return;
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const r = await addEmailSuppression(email);
      setDraft("");
      setNotice(r?.added === false ? `${r.email || email} was already suppressed.` : `Added. Zavi's own sender will not email ${r?.email || email}. Campaigns sent through SendGrid, Mailchimp or Klaviyo follow that tool's own unsubscribe list, so add the address there too.`);
      setTick((v) => v + 1);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const rows = data?.rows ?? [];
  const shown = loadedPage;
  const size = data?.page_size || 50;
  const hasNext = !!data && shown * size < data.total;
  const settled = shown === page;
  const paging = !!data && rows.length > 0 && (shown > 1 || hasNext);
  const firstRow = (shown - 1) * size + 1;
  const steady = useSteadyHeight(query, paging && !settled);
  return (
    <div className="grid gap-3">
      <input
        type="search"
        aria-label="Search suppressed addresses"
        placeholder="Search an address"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className={INPUT}
      />
      {canEdit && (
        <div className="grid gap-1.5">
          <label htmlFor="email-suppress-address" className="text-[13px] font-medium text-ink">
            Never email
          </label>
          <div className="flex min-w-0 gap-2">
            <input
              id="email-suppress-address"
              type="email"
              autoComplete="off"
              placeholder="name@example.com"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
                e.preventDefault();
                if (e.currentTarget.checkValidity()) void add();
              }}
              className={`${INPUT} flex-1`}
            />
            <button type="button" disabled={busy || !draft.trim()} onClick={() => void add()} className={BTN}>
              {busy ? "Adding…" : "Add"}
            </button>
          </div>
        </div>
      )}
      {data?.masked && <p className="text-[12px] leading-[18px] text-inkMuted">Addresses are partly hidden for your role. Search by domain, like example.com.</p>}
      {notice && (
        <p role="status" className="text-[13px] text-ink">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="text-[13px] text-danger">
          {error}
        </p>
      )}
      {loadError && (
        <p role="alert" className="flex flex-wrap items-center gap-2 text-[13px] text-danger">
          {loadError}
          <button type="button" onClick={() => setTick((v) => v + 1)} className={BTN}>
            Retry
          </button>
        </p>
      )}
      {!data && !loadError && <Skeleton className="h-5 w-[46%]" />}
      {data && (
        <div ref={steady.ref} style={{ minHeight: steady.minHeight }} className="grid min-w-0 content-start">
        <ul aria-label="Suppressed addresses" data-testid="contacts-suppressed-stacked" className={STACK_LIST}>
          {rows.length === 0 ? (
            <li className={EMPTY_CELL}>{query ? "No suppressed address matches that." : "No suppressed addresses yet."}</li>
          ) : (
            rows.map((r) => (
              <li key={`${r.email}:${r.created_at}`} data-testid="suppressed-stacked-row" className={STACK_ROW}>
                <p className="text-ink [overflow-wrap:anywhere]">{r.email}</p>
                <div className={STACK_META}>
                  <span>{REASON[r.reason] ?? r.reason}</span>
                  <span className="tabular-nums">Since {day(r.created_at)}</span>
                </div>
              </li>
            ))
          )}
        </ul>
        <div className={`${TABLE_WRAP} ${WIDE_ONLY}`}>
          <table className="w-full min-w-[420px] border-collapse">
            <thead className="bg-bone">
              <tr>
                <th className={TH}>Email</th>
                <th className={TH}>Reason</th>
                <th className={`${TH} text-right`}>Since</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-rule">
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={3} className={EMPTY_CELL}>
                    {query ? "No suppressed address matches that." : "No suppressed addresses yet."}
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr key={`${r.email}:${r.created_at}`}>
                    <td className={`${TD} [overflow-wrap:anywhere]`}>{r.email}</td>
                    <td className={`${TD} text-inkMuted`}>{REASON[r.reason] ?? r.reason}</td>
                    <td className={`${TD} whitespace-nowrap text-right text-inkMuted`}>{day(r.created_at)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        </div>
      )}
      {paging && (
        <EmailPager
          label="Suppressed address pages"
          testId="contacts-suppressed-pager"
          rangeTestId="contacts-suppressed-range"
          range={pageRange(firstRow, firstRow + rows.length - 1, data.total)}
          canPrev={shown > 1 && settled}
          canNext={hasNext && settled}
          onPrev={() => setPage(shown - 1)}
          onNext={() => setPage(shown + 1)}
        />
      )}
    </div>
  );
}

type View = "people" | "lists" | "supp";

export function EmailContactsSection() {
  const ws = useWorkspaceOptional();
  const role = ws?.role ?? null;
  const canManage = role === "owner" || role === "admin";
  const company = ws?.tenantName?.trim() || "you";
  const [view, setView] = useState<View>("people");
  const [lists, setLists] = useState<ContactList[] | null>(null);
  const [archived, setArchived] = useState<ArchivedContactList[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [testIds, setTestIds] = useState<Set<string>>(new Set());
  const [counts, setCounts] = useState<ContactCounts | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [dialog, setDialog] = useState<{ kind: "csv"; startNew: boolean } | { kind: "database" } | { kind: "archived" } | null>(null);
  useEffect(() => {
    if (!canManage) return;
    if (takeDatabaseImportRequest()) setDialog({ kind: "database" });
    const open = () => {
      if (takeDatabaseImportRequest()) setDialog({ kind: "database" });
    };
    window.addEventListener(OPEN_DATABASE_IMPORT_EVENT, open);
    return () => window.removeEventListener(OPEN_DATABASE_IMPORT_EVENT, open);
  }, [canManage]);
  const [status, setStatus] = useState<string | null>(null);
  const confirmation = useAutoDismissMessage();
  const [cardError, setCardError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setLists(await getContactLists());
      setListError(null);
    } catch (e) {
      setListError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload, reloadKey]);

  useEffect(() => {
    let live = true;
    getArchivedContactLists()
      .then((rows) => {
        if (!live) return;
        setArchived(rows);
        if (rows.length === 0) setDialog((d) => (d?.kind === "archived" ? null : d));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [reloadKey]);

  useEffect(() => {
    let live = true;
    getEmailTestLists()
      .then((r) => {
        if (!live) return;
        const zavi = r.routes.find((x) => x.route === "zavi_list");
        setTestIds(new Set((zavi?.lists ?? []).filter((l) => l.marked).map((l) => l.id)));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [reloadKey]);

  const importable = useMemo(() => (lists ?? []).filter((l) => !testIds.has(l.id)), [lists, testIds]);
  const refresh = () => setReloadKey((k) => k + 1);
  const imported = (message: string, needsReading: boolean) => {
    setDialog(null);
    if (needsReading) {
      confirmation.clear();
      setStatus(message);
    } else {
      setStatus(null);
      confirmation.clear();
      toast.add({ type: "success", title: message, position: "top-center", dismissible: false, timeout: IMPORTED_SHOWN_MS });
    }
    refresh();
  };

  const stats: Array<[string, number | null]> = [
    ["Contacts", counts?.contacts ?? null],
    ["Lists", counts?.lists ?? lists?.length ?? null],
    ["Unsubscribed", counts?.unsubscribed ?? null],
    ["Bounced", counts?.bounced ?? null],
  ];

  return (
    <section aria-labelledby="email-contacts-title" className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="email-contacts-title" className="mr-auto text-[18px] font-semibold leading-6 tracking-tight text-ink">
          Contacts
        </h2>
        <div
          data-testid="email-contacts-actions"
          className={`flex gap-2 compact:grid compact:w-full [@container(max-width:640px)]:grid [@container(max-width:640px)]:w-full ${
            canManage ? "compact:grid-cols-2 [@container(max-width:640px)]:grid-cols-2" : "compact:grid-cols-1 [@container(max-width:640px)]:grid-cols-1"
          }`}
        >
          {canManage && (
            <button type="button" aria-label="Import from database" onClick={() => setDialog({ kind: "database" })} className={BTN}>
              <Database aria-hidden className="h-4 w-4" />
              <span className={NARROW_HIDE}>Import from database</span>
              <span className="hidden compact:inline [@container(max-width:640px)]:inline">From database</span>
            </button>
          )}
          <button type="button" aria-label="Upload CSV" onClick={() => setDialog({ kind: "csv", startNew: false })} className={BTN}>
            <Upload aria-hidden className="h-4 w-4" />
            Upload CSV
          </button>
          {archived.length > 0 && (
            <button
              type="button"
              onClick={() => setDialog({ kind: "archived" })}
              className={`${BTN} ${canManage ? "compact:col-span-2 [@container(max-width:640px)]:col-span-2" : ""}`}
            >
              Archived lists
            </button>
          )}
        </div>
      </div>

      {(status ?? confirmation.message) && (
        <div className="flex items-start gap-2 rounded-[10px] bg-mintDeep/10 px-3 py-2.5">
          <p role="status" className="min-w-0 flex-1 text-[13px] leading-5 text-ink">
            {status ?? confirmation.message}
          </p>
          <button type="button" aria-label="Dismiss" onClick={() => { setStatus(null); confirmation.clear(); }} className={`shrink-0 cursor-pointer rounded-md border-0 bg-transparent p-0.5 text-inkMuted hover:text-ink ${FOCUS}`}>
            <X aria-hidden className="h-4 w-4" />
          </button>
        </div>
      )}

      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-rule bg-rule sm:grid-cols-4">
        {stats.map(([label, value]) => (
          <div key={label} className="min-w-0 bg-white px-4 py-3">
            <dt className="text-[12px] text-inkMuted">{label}</dt>
            <dd className="mt-0.5 text-[20px] font-semibold leading-7 tabular-nums text-ink" data-testid={`stat-${label.toLowerCase()}`}>
              {value === null ? "–" : n(value)}
            </dd>
            {label === "Unsubscribed" && (
              <dd data-testid="stat-unsubscribed-note" className="mt-0.5 text-[12px] leading-4 text-inkMuted">
                These people won't get your emails.
              </dd>
            )}
          </div>
        ))}
      </dl>

      <div role="group" aria-label="Contacts view" className="inline-flex items-center gap-0.5 self-start rounded-[11px] bg-creamDeep p-[3px]">
        {(
          [
            ["people", "People"],
            ["lists", "Lists"],
            ["supp", "Suppressed"],
          ] as Array<[View, string]>
        ).map(([v, label]) => (
          <button
            key={v}
            type="button"
            aria-pressed={view === v}
            onClick={() => setView(v)}
            className={`${SEGMENT} ${view === v ? SEGMENT_ON : SEGMENT_OFF}`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="min-w-0">
        <div hidden={view !== "people"}>
          <PeopleView lists={lists ?? []} reloadKey={reloadKey} onCounts={setCounts} canErase={canManage} onErased={refresh} />
        </div>
        {view === "lists" && (
          <div className="grid gap-3">
            {listError && (
              <p role="alert" className="flex flex-wrap items-center gap-2 text-[13px] text-danger">
                {listError}
                <button type="button" onClick={() => void reload()} className={BTN}>
                  Retry
                </button>
              </p>
            )}
            {cardError && (
              <p role="alert" className="text-[13px] text-danger">
                {cardError}
              </p>
            )}
            {lists === null && !listError ? (
              <Skeleton className="h-24 w-full" rounded="rounded-2xl" />
            ) : (
              <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {(lists ?? []).map((l) => (
                  <ListCard key={l.id} list={l} test={testIds.has(l.id)} canConsent={canManage} onChanged={refresh} onError={setCardError} />
                ))}
              </ul>
            )}
          </div>
        )}
        {view === "supp" && <SuppressedView canEdit={canManage} onChanged={refresh} />}
      </div>

      {dialog?.kind === "csv" && (
        <CsvDialog
          lists={importable}
          startNew={dialog.startNew}
          canConsent={canManage}
          company={company}
          onClose={() => setDialog(null)}
          onImported={imported}
        />
      )}
      {dialog?.kind === "archived" && archived.length > 0 && (
        <ArchivedListsDialog
          lists={archived}
          canManage={canManage}
          onClose={() => setDialog(null)}
          onUnarchived={(message, needsAction) => {
            if (needsAction) {
              confirmation.clear();
              setStatus(message);
            } else {
              setStatus(null);
              confirmation.show(message);
            }
            refresh();
          }}
        />
      )}
      {dialog?.kind === "database" && canManage && (
        <DatabaseDialog lists={importable} canConsent={canManage} company={company} onClose={() => setDialog(null)} onImported={imported} />
      )}
    </section>
  );
}
