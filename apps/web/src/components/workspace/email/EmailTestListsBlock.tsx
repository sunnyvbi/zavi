"use client";

import { useCallback, useEffect, useState } from "react";
import { confirmAction } from "@/components/ui/ConfirmDialog";
import { toast } from "@/components/ui/toast";
import { Skeleton } from "../Skeleton";
import { useWorkspaceOptional } from "../WorkspaceShell";
import { isMember } from "@/lib/members";
import { EmailCheckbox } from "./EmailCheckbox";
import {
  getEmailTestLists,
  SENDGRID_CONNECTED_EVENT,
  setEmailTestList,
  type OrphanMark,
  type TestListRoute,
  type TestListRouteView,
  type TestListRow,
} from "@/lib/workspace/emailCampaignSettingsApi";

const FOCUS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30 focus-visible:ring-offset-1 focus-visible:ring-offset-cream";
const ROW = "grid gap-2 p-5 sm:grid-cols-[180px_minmax(0,1fr)] sm:gap-6";
const BTN = `inline-flex h-10 shrink-0 items-center justify-center rounded-cta border border-rule bg-white px-3.5 cursor-pointer transition-colors hover:border-inkLight hover:bg-creamDeep text-[13px] font-medium text-ink disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS}`;
const BTN_ROW = `inline-flex h-8 shrink-0 items-center justify-center rounded-cta border border-rule bg-white px-3 cursor-pointer transition-colors hover:border-inkLight hover:bg-creamDeep text-[13px] font-medium text-ink disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS}`;

export const TEST_LIST_COPY = {
  intro: "Zavi never sends to a list you tick here. Test emails to you still go through.",
  hint: "Looks like a test list",
  partial: "Zavi could not read every list here, so some may be missing. Marks stay on until a full read.",
  notConnected: "Not connected.",
  empty: "No lists here yet.",
  refreshFailed: "That change was sent, but the lists could not be read back. Reload to see where things stand.",
  locked: "Zavi could not read every list here, so marks stay on until it can.",
  unreadable: "Can't reach it right now",
  keyRejected: "Its key stopped working",
  partialLine: "Not every list could be read. Marks stay on until a full read.",
  testGroup: "Look like test lists",
  realGroup: "Real audiences",
} as const;

export const joinNames = (names: string[]) =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

export const unreadableLine = (names: string[]) => `${joinNames(names)} lists can't be read right now, so they can't be marked.`;
export const partialToolsLine = (names: string[]) => `Not every ${joinNames(names)} list could be read. Marks stay on until a full read.`;
export const needsKeyLine = (label: string) => `${label} is connected but its key can't run campaigns yet. Paste a key with campaign permissions in Overview → ${label}.`;
export const notCheckedLine = (label: string) => `Zavi can't check your ${label} test list right now. It stays protected until it can.`;

export function toolProblemLine(status: TestListRouteView["status"], error: string | null): string | null {
  if (error && /rejected the key/i.test(error)) return TEST_LIST_COPY.keyRejected;
  if (status === "unreadable") return TEST_LIST_COPY.unreadable;
  if (status === "partial") return TEST_LIST_COPY.partialLine;
  return null;
}

const people = (n: number | null) => (n === null ? "Size not known" : `${n.toLocaleString("en-US")} ${n === 1 ? "person" : "people"}`);

type View = { routes: TestListRouteView[]; orphans: OrphanMark[] };

export function EmailTestListsBlock() {
  const role = useWorkspaceOptional()?.role ?? null;
  const canEdit = role !== null && !isMember(role);
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async (fresh = false): Promise<boolean> => {
    try {
      const r = await getEmailTestLists({ fresh });
      setView({ routes: Array.isArray(r?.routes) ? r.routes : [], orphans: Array.isArray(r?.orphans) ? r.orphans : [] });
      setError(null);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  }, []);

  useEffect(() => {
    void load();
    const again = () => void load();
    window.addEventListener(SENDGRID_CONNECTED_EVENT, again);
    return () => window.removeEventListener(SENDGRID_CONNECTED_EVENT, again);
  }, [load]);

  const retry = async () => {
    setError(null);
    await load(true);
  };

  const confirmUnmark = (name: string | null) =>
    confirmAction({
      title: name ? `Let Zavi send real emails to "${name}"?` : "Remove this test mark?",
      description: "Today Zavi never sends a real email to this list. After this, an approved email or Autopilot can send to everyone on it.",
      confirmLabel: "Remove test mark",
    });

  const unmarkOrphan = async (o: OrphanMark) => {
    if (!canEdit || busy !== null || !o.can_unmark) return;
    if (!(await confirmUnmark(null))) return;
    await change(o.route, o.list_id, false, "That list");
  };

  const markFromRow = async (r: TestListRouteView, l: TestListRow, marked: boolean) => {
    if (!canEdit || busy !== null || (l.marked && r.status !== "complete")) return;
    if (!marked) {
      if (!(await confirmUnmark(l.name))) return;
    } else if (!l.looks_like_test) {
      const ok = await confirmAction({
        title: `Mark "${l.name}" as a test list?`,
        description: `${l.people === null ? "Zavi does not know how many people are on it" : `It has ${l.people.toLocaleString("en-US")} ${l.people === 1 ? "person" : "people"}`}, in ${r.label}. Once it is a test list, Zavi never sends a real email to it; only test emails go there. Test lists are usually a handful of your own addresses.`,
        confirmLabel: "Mark as a test list",
      });
      if (!ok) return;
    }
    await change(r.route, l.id, marked, l.name);
  };

  const change = async (route: TestListRoute, listId: string, marked: boolean, name: string) => {
    const key = `${route}:${listId}`;
    setBusy(key);
    setError(null);
    try {
      await setEmailTestList(route, listId, marked);
      if (await load()) toast.add({ type: "success", title: marked ? `"${name}" is a test list now.` : `"${name}" is no longer a test list.`, position: "top-center", dismissible: false });
      else setError(TEST_LIST_COPY.refreshFailed);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const routes = view?.routes ?? [];
  const orphans = view?.orphans ?? [];
  const rows = routes.flatMap((r) => r.lists.map((l) => ({ r, l })));
  const groups = [
    { key: "test", label: TEST_LIST_COPY.testGroup, rows: rows.filter(({ l }) => l.marked || l.looks_like_test) },
    { key: "real", label: TEST_LIST_COPY.realGroup, rows: rows.filter(({ l }) => !l.marked && !l.looks_like_test) },
  ].filter((g) => g.rows.length > 0);
  const captioned = groups.length > 1;
  const unreadable = routes.filter((r) => r.status === "unreadable").map((r) => r.label);
  const partial = routes.filter((r) => r.status === "partial").map((r) => r.label);
  const needsKey = routes.filter((r) => r.status === "needs_permissions").map((r) => r.label);
  const orphanRoutes = routes.filter((r) => orphans.some((o) => o.route === r.route));

  return (
    <section aria-labelledby="email-test-lists-title" data-testid="email-test-lists" className={ROW}>
      <div>
        <h3 id="email-test-lists-title" className="text-[13px] font-medium leading-5 text-ink sm:pt-1.5">
          Test lists
        </h3>
        <small className="mt-0.5 block text-[12px] leading-[18px] text-inkMuted">{TEST_LIST_COPY.intro}</small>
      </div>
      <div className="grid min-w-0 gap-3">
        {!view && !error && <Skeleton className="h-10 w-full" rounded="rounded-[10px]" />}
        {error && (
          <p role="alert" className="flex flex-wrap items-center gap-2 text-[13px] text-danger">
            {error}
            {!view && (
              <button type="button" className={BTN} onClick={() => void retry()}>
                Retry
              </button>
            )}
          </p>
        )}
        {view && (
          <>
            {groups.length === 0 && orphans.length === 0 && unreadable.length === 0 && partial.length === 0 && needsKey.length === 0 && (
              <p className="text-[13px] text-inkMuted">{TEST_LIST_COPY.empty}</p>
            )}
            {groups.map((g) => (
              <div key={g.key} role={captioned ? "group" : undefined} aria-label={captioned ? g.label : undefined} className="grid gap-1.5">
                {captioned && <p className="text-[12px] font-medium text-inkMuted">{g.label}</p>}
                <ul data-testid="test-lists-rows" className="divide-y divide-rule rounded-xl border border-rule">
                  {g.rows.map(({ r, l }) => {
                    return (
                      <li key={`${r.route}:${l.id}`}>
                        <label className="flex min-h-[44px] cursor-pointer flex-wrap content-center items-start gap-x-2.5 gap-y-1 px-3 py-2">
                          <EmailCheckbox
                            className="mt-0.5"
                            checked={l.marked}
                            disabled={!canEdit || busy !== null || (l.marked && r.status !== "complete")}
                            title={l.marked && r.status !== "complete" ? TEST_LIST_COPY.locked : undefined}
                            onChange={(e) => void markFromRow(r, l, e.target.checked)}
                          />
                          <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2.5 gap-y-1">
                            <span data-testid="test-list-name" className="min-w-0 flex-1 basis-[10rem] break-words text-[14px] text-ink">
                              {l.name}
                            </span>
                            <span data-testid="test-list-meta" className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                              <span className="whitespace-nowrap text-[12px] text-inkMuted">{r.label}</span>
                              <span className="whitespace-nowrap rounded-full bg-bone px-2 py-0.5 text-[12px] font-medium tabular-nums text-inkMuted">{people(l.people)}</span>
                              {l.looks_like_test && !l.marked && !captioned && <span className="text-[12px] text-inkMuted">{TEST_LIST_COPY.hint}</span>}
                            </span>
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
            {orphanRoutes.map((r) => (
              <fieldset key={r.route} data-testid={`test-lists-${r.route}`} className="min-w-0">
                <legend className="text-[12px] font-medium text-inkMuted">{r.label}</legend>
                {r.status === "not_connected" && <p className="mt-1 text-[13px] text-inkMuted">{TEST_LIST_COPY.notConnected}</p>}
                <ul className="mt-1.5 grid gap-1.5" aria-label={`${r.label} marks not found`}>
                  {orphans
                    .filter((o) => o.route === r.route)
                    .map((o) => (
                      <li key={o.list_id} className="rounded-[10px] bg-bone px-3 py-2.5 text-[13px] leading-5">
                        <p className="text-ink">{o.reason === "not_found" ? `A list you marked is no longer in ${r.label}.` : notCheckedLine(r.label)}</p>
                        {o.reason === "not_found" && <p className="text-inkMuted">{o.note}</p>}
                        {canEdit && o.can_unmark && (
                          <button type="button" className={`${BTN_ROW} mt-2`} disabled={busy !== null} onClick={() => void unmarkOrphan(o)}>
                            Unmark
                          </button>
                        )}
                      </li>
                    ))}
                </ul>
              </fieldset>
            ))}
            {needsKey.map((label) => (
              <p key={label} data-testid="test-lists-needs-key" className="text-[13px] leading-5 text-inkMuted">
                {needsKeyLine(label)}
              </p>
            ))}
            {partial.length > 0 && (
              <p data-testid="test-lists-partial" className="text-[13px] leading-5 text-inkMuted">
                {partialToolsLine(partial)}
              </p>
            )}
            {unreadable.length > 0 && (
              <p data-testid="test-lists-unreadable" className="text-[13px] leading-5 text-inkMuted">
                {unreadableLine(unreadable)}
              </p>
            )}
            {!canEdit && <p className="text-[13px] leading-5 text-inkMuted">Only a workspace owner or admin can change test lists.</p>}
          </>
        )}
      </div>
    </section>
  );
}
