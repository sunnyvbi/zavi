"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";
import { toast } from "@/components/ui/toast";
import { cx, FOCUS_RING } from "./shared";

export type SiteReadState = {
  state: "ok" | "error" | "unknown";
  site: string | null;
  error_code: string | null;
};

type RescanBody = {
  site_read?: SiteReadState;
  first_run?: { ran?: boolean };
  error?: { message?: string };
};

export function shouldShowSiteNotice(
  siteRead: SiteReadState | null,
  pendingCards: number | null,
  channels: ReadonlyArray<{ last_run_at: string | null; work_state: string }>,
): boolean {
  if (siteRead?.state !== "error") return false;
  if (pendingCards === null || pendingCards > 0) return false;
  return channels.every((c) => !c.last_run_at && c.work_state === "idle");
}

export function cleanDomainInput(raw: string): string | null {
  const s = raw.trim();
  if (!s || /\s/.test(s)) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    const host = u.hostname.toLowerCase();
    if (!/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(host)) return null;
    return host;
  } catch {
    return null;
  }
}

function hostOf(site: string | null): string | null {
  if (!site) return null;
  try {
    return new URL(site).hostname;
  } catch {
    return site;
  }
}

async function messageOf(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as RescanBody;
    return body.error?.message || fallback;
  } catch {
    return fallback;
  }
}

export function SiteUnreadableNotice({
  siteRead,
  onDone,
}: {
  siteRead: SiteReadState;
  onDone: () => void;
}) {
  const [saved, setSaved] = useState<string | null>(null);
  const stale = saved !== null && hostOf(siteRead.site) !== saved;
  const noSite = siteRead.error_code === "seo_site_unknown" && !stale;
  const unchecked = siteRead.error_code === "seo_site_unchecked" || stale;
  const [busy, setBusy] = useState<null | "rescan" | "save">(null);
  const [message, setMessage] = useState<string | null>(null);
  const [editing, setEditing] = useState(noSite);
  const [draft, setDraft] = useState("");
  const host = stale ? saved : hostOf(siteRead.site);

  const rescan = async (): Promise<boolean> => {
    setBusy("rescan");
    setMessage(null);
    try {
      const res = await apiFetch("/api/channels/site-rescan", { method: "POST" });
      if (!res.ok) {
        setMessage(await messageOf(res, "We couldn't check your site just now. Try again in a minute."));
        return false;
      }
      const body = (await res.json()) as RescanBody;
      const read = body.site_read;
      if (read?.state === "ok") {
        toast.add({
          type: "success",
          title: `Read ${hostOf(read.site) ?? "your site"}`,
          description: body.first_run?.ran ? "Your first channel run is starting." : undefined,
        });
        onDone();
        return true;
      }
      const tried = hostOf(read?.site ?? null) ?? host;
      setMessage(
        tried
          ? `Still couldn't read ${tried}. Check that it loads in a browser, or use a different URL.`
          : "Still couldn't read your site. Check the address, or use a different URL.",
      );
      return false;
    } catch {
      setMessage("We couldn't check your site just now. Try again in a minute.");
      return false;
    } finally {
      setBusy(null);
    }
  };

  const saveAndRescan = async () => {
    const domain = cleanDomainInput(draft);
    if (!domain) {
      setMessage("Enter a website address like yourcompany.com.");
      return;
    }
    setBusy("save");
    setMessage(null);
    try {
      const res = await apiFetch("/api/connectors/company-facts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ facts: [{ key: "domain", value: domain }] }),
      });
      if (!res.ok) {
        setMessage(await messageOf(res, "We couldn't save that address. Try again."));
        setBusy(null);
        return;
      }
    } catch {
      setMessage("We couldn't save that address. Try again.");
      setBusy(null);
      return;
    }
    setSaved(domain);
    setEditing(false);
    if (!(await rescan())) onDone();
  };

  return (
    <div
      role="status"
      className="m-3 rounded-xl border border-rule bg-cream px-3 py-2.5 text-[13px] text-ink"
    >
      <p className="font-semibold">
        {noSite
          ? "Add your website so Zavi can start"
          : unchecked
            ? `Zavi hasn't read ${host ?? "your site"} yet`
            : `We couldn't read ${host ?? "your site"}`}
      </p>
      <p className="mt-1 text-inkLight">
        {noSite || unchecked
          ? "Zavi starts your first channel run once it has read your site."
          : "Zavi starts your first channel run once it can read your site. It may be down, blocking crawlers, or the address may be wrong."}
      </p>
      {editing ? (
        <form
          className="mt-2 flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void saveAndRescan();
          }}
        >
          <label className="sr-only" htmlFor="site-unreadable-domain">
            Website address
          </label>
          <input
            id="site-unreadable-domain"
            type="text"
            inputMode="url"
            autoComplete="url"
            placeholder="yourcompany.com"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={busy !== null}
            className={cx("h-10 min-w-0 flex-1 rounded-lg border border-rule bg-white px-3 text-[16px]", FOCUS_RING)}
          />
          <button
            type="submit"
            disabled={busy !== null || !draft.trim()}
            className={cx("h-10 rounded-full bg-ink px-4 text-[14px] font-semibold text-white disabled:opacity-50", FOCUS_RING)}
          >
            {busy === "save" ? "Saving…" : busy === "rescan" ? "Checking…" : "Save and check"}
          </button>
          {!noSite && (
            <button
              type="button"
              onClick={() => setEditing(false)}
              disabled={busy !== null}
              className={cx("h-10 px-2 text-[14px] font-semibold underline", FOCUS_RING)}
            >
              Cancel
            </button>
          )}
        </form>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void rescan()}
            disabled={busy !== null}
            className={cx("h-10 rounded-full bg-ink px-4 text-[14px] font-semibold text-white disabled:opacity-50", FOCUS_RING)}
          >
            {busy === "rescan" ? "Checking your site…" : unchecked ? "Check it now" : "Try again"}
          </button>
          <button
            type="button"
            onClick={() => {
              setEditing(true);
              setMessage(null);
            }}
            disabled={busy !== null}
            className={cx("h-10 px-2 text-[14px] font-semibold underline", FOCUS_RING)}
          >
            Use a different URL
          </button>
        </div>
      )}
      {message && (
        <p role="alert" className="mt-2 text-[13px] text-warn dark:text-marigold">
          {message}
        </p>
      )}
    </div>
  );
}
