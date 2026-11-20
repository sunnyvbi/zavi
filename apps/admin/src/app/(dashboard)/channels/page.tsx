"use client";

import { useCallback, useEffect, useState } from "react";
import { adminApiFetch } from "@/lib/api-admin";
import { readLockPreview, type LockImpact } from "@/lib/channel-lock-preview";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type ChannelRow = {
  slug: string;
  name: string;
  category: string;
  readiness: string;
  executor: string;
  locked: boolean;
};

type PendingLock = { channel: ChannelRow; impact: LockImpact | null };

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const err = body.error as { message?: string } | undefined;
    throw new Error(err?.message ?? `HTTP ${res.status}`);
  }
  return body;
}

export default function AdminChannelsPage() {
  const [channels, setChannels] = useState<ChannelRow[] | null>(null);
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingLock | null>(null);

  const readRows = useCallback(async (): Promise<ChannelRow[] | null> => {
    try {
      const body = await readJson(await adminApiFetch("/api/admin/channel-locks"));
      const rows = (body.channels as ChannelRow[]) ?? [];
      setChannels(rows);
      return rows;
    } catch {
      return null;
    }
  }, []);

  const load = useCallback(async () => {
    try {
      const body = await readJson(await adminApiFetch("/api/admin/channel-locks"));
      setChannels((body.channels as ChannelRow[]) ?? []);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function startLock(channel: ChannelRow) {
    setErr(null);
    setNotice(null);
    setBusySlug(channel.slug);
    setPending({ channel, impact: await readLockPreview(channel.slug) });
    setBusySlug(null);
  }

  async function setLocked(channel: ChannelRow, locked: boolean) {
    setErr(null);
    setNotice(null);
    setBusySlug(channel.slug);
    try {
      const body = await readJson(
        await adminApiFetch(`/api/admin/channel-locks/${encodeURIComponent(channel.slug)}`, {
          method: "POST",
          body: JSON.stringify({ locked }),
        }),
      );
      if (locked) {
        const errors = (body.errors as string[] | undefined) ?? [];
        setNotice(
          `${channel.name} locked. Cancelled ${body.cancelled_runs} runs and deleted ${body.deleted_schedules} schedules across ${body.companies} companies.` +
            (body.live_campaigns_note ? ` ${body.live_campaigns_note}` : "") +
            (errors.length ? ` Some cleanup failed: ${errors.join("; ")}` : ""),
        );
      } else {
        setNotice(`${channel.name} is available again.`);
      }
      setPending(null);
      await load();
    } catch (e) {
      const rows = await readRows();
      const now = rows?.find((r) => r.slug === channel.slug);
      if (now && now.locked === locked) {
        setPending(null);
        setNotice(
          locked
            ? `${channel.name} is locked. The reply to Lock did not arrive, so the cleanup counts are not shown.`
            : `${channel.name} is available again.`,
        );
      } else {
        setErr(
          `${locked ? "Lock" : "Unlock"} did not go through: ${(e as Error).message}. ` +
            (now ? `The table shows ${channel.name} is still ${now.locked ? "locked" : "available"}.` : "The table could not be reloaded, so refresh the page to see the current state."),
        );
      }
    } finally {
      setBusySlug(null);
    }
  }

  return (
    <div className="max-w-4xl mx-auto p-6">
      <div className="mb-5">
        <div className="text-xs uppercase tracking-[0.2em] text-slate-500">Zavi · admin</div>
        <h1 className="font-display font-semibold text-2xl text-slate-900 mt-1">Channels</h1>
        <p className="text-sm text-slate-500 mt-1">
          Lock a channel to show it as &ldquo;Coming soon&rdquo; for every company. A locked
          channel can&apos;t start a run from anywhere. Locking cancels its running runs and
          deletes its schedules; unlocking restores neither. Changes are audit-logged.
        </p>
      </div>

      {err && (
        <div role="alert" className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 mb-4">
          {err}
        </div>
      )}
      {notice && (
        <div role="status" className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800 mb-4">
          {notice}
        </div>
      )}

      {channels === null ? (
        <div className="text-sm text-slate-500">{err ? "" : "Loading…"}</div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2 font-medium">Channel</th>
                <th className="px-4 py-2 font-medium">Category</th>
                <th className="px-4 py-2 font-medium">Readiness</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {channels.map((c) => (
                <tr key={c.slug} className="border-t border-slate-100">
                  <td className="px-4 py-2.5">
                    <div className="font-medium text-slate-900">{c.name}</div>
                    <div className="font-mono text-xs text-slate-400">{c.slug}</div>
                  </td>
                  <td className="px-4 py-2.5 text-slate-600">{c.category}</td>
                  <td className="px-4 py-2.5 text-slate-600">{c.readiness}</td>
                  <td className="px-4 py-2.5">
                    <span
                      className={
                        "inline-block rounded-full px-2 py-0.5 text-xs font-medium " +
                        (c.locked ? "bg-amber-100 text-amber-800" : "bg-emerald-100 text-emerald-800")
                      }
                    >
                      {c.locked ? "Locked" : "Available"}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <button
                      type="button"
                      disabled={busySlug !== null}
                      onClick={() => void (c.locked ? setLocked(c, false) : startLock(c))}
                      className={
                        "rounded-md px-3 py-1.5 text-xs font-semibold disabled:opacity-50 " +
                        (c.locked
                          ? "border border-slate-300 text-slate-700 hover:bg-slate-50"
                          : "bg-rose-600 text-white hover:bg-rose-700")
                      }
                    >
                      {busySlug === c.slug ? "Working…" : c.locked ? "Unlock" : "Lock"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Dialog open={pending !== null} onOpenChange={(open) => !open && busySlug === null && setPending(null)}>
        <DialogContent>
          {pending && (
            <>
              <DialogHeader>
                <DialogTitle>Lock {pending.channel.name}?</DialogTitle>
                <DialogDescription>
                  {pending.impact ? (
                    <>
                      This cancels {pending.impact.running_runs} running runs and deletes{" "}
                      {pending.impact.schedules} schedules across {pending.impact.companies} companies.
                      This can&apos;t be undone.
                    </>
                  ) : (
                    <>
                      The preview could not be read, so the number of runs, schedules and live
                      campaigns is unknown. You can still lock. Locking cancels the channel&apos;s
                      running runs and deletes its schedules, does not pause live ads, and
                      can&apos;t be undone.
                    </>
                  )}
                </DialogDescription>
              </DialogHeader>
              {pending.impact?.schedules_skipped_reason && (
                <p className="text-sm text-amber-800">{pending.impact.schedules_skipped_reason}</p>
              )}
              {pending.impact?.live_campaigns_note && (
                <p className="text-sm font-medium text-amber-800">{pending.impact.live_campaigns_note}</p>
              )}
              {err && (
                <p role="alert" data-testid="lock-dialog-error" className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
                  {err}
                </p>
              )}
              <DialogFooter>
                <button
                  type="button"
                  disabled={busySlug !== null}
                  onClick={() => setPending(null)}
                  className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={busySlug !== null}
                  onClick={() => void setLocked(pending.channel, true)}
                  className="rounded-md bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-700 disabled:opacity-50"
                >
                  {busySlug === pending.channel.slug ? "Locking…" : `Lock ${pending.channel.name}`}
                </button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
