import { useState, type ReactNode } from "react";
import { btn } from "../../agent/dashboard-ui";
import { FindAdAccountId } from "./FindAdAccountId";
import { useTiktokAdAccounts } from "./useTiktokAdAccounts";
import type { AdAccount } from "./api";

function AccountLine({ a }: { a: AdAccount }) {
  const paused = a.status && a.status !== "ENABLE";
  return (
    <span className="min-w-0">
      <span className="block truncate text-[15px] font-semibold text-ink">{a.name}</span>
      <span className="block text-[13px] text-inkMuted">
        ID {a.advertiser_id}
        {a.currency ? ` · ${a.currency}` : ""}
        {paused ? ` · ${a.status?.toLowerCase().replace(/_/g, " ")}` : ""}
      </span>
    </span>
  );
}

function Frame({ title, intro, children }: { title: string; intro?: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-rule bg-creamDeep p-5" aria-label="TikTok ad account" data-testid="tiktok-ad-account">
      <p className="text-[15px] font-semibold text-ink">{title}</p>
      {intro && <p className="mt-1 text-[14px] leading-6 text-inkMuted">{intro}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function TiktokAdAccountCard({ onChanged, onReconnect }: { onChanged?: () => void; onReconnect?: () => void | Promise<unknown> }) {
  const { state, busy, error, refresh, select, add, clearError } = useTiktokAdAccounts(onChanged);
  const [mode, setMode] = useState<"view" | "change" | "add">("view");
  const reconnect = error?.code === "tiktok_ads_token_revoked";
  const errorText = error ? (reconnect ? "Your TikTok login needs to be connected again before Zavi can check ad accounts." : error.message) : null;
  const reconnectButton = reconnect && onReconnect ? (
    <button type="button" onClick={() => void onReconnect()} className={btn.primary}>
      Reconnect TikTok Ads
    </button>
  ) : null;

  if (!state) {
    if (busy === "loading") {
      return <div className="h-[92px] animate-pulse rounded-2xl border border-rule bg-creamDeep" aria-label="Loading your TikTok ad account" />;
    }
    return (
      <Frame title="We couldn't load your TikTok ad account" intro={errorText ?? undefined}>
        {reconnectButton ?? (
          <button type="button" onClick={() => void refresh()} className={btn.secondary}>
            Try again
          </button>
        )}
      </Frame>
    );
  }
  if (!state.connected) return null;

  const selected = state.accounts.find((a) => a.advertiser_id === state.selected_id) ?? null;
  const addAccount = async (input: string) => {
    const ok = await add(input);
    if (ok) setMode("view");
    return ok;
  };
  const searchAgain = (
    <button type="button" onClick={() => void refresh()} disabled={busy !== null} className={btn.secondary}>
      {busy === "refreshing" ? "Searching…" : "Search again"}
    </button>
  );

  if (state.needs === "paste" || mode === "add") {
    return (
      <Frame
        title={state.needs === "paste" ? "Add your TikTok ad account" : "Add another ad account"}
        intro={
          state.needs === "paste"
            ? "Your TikTok login is connected, but we couldn't find an ad account on it automatically. Tell us which one to use. It takes about a minute."
            : "Paste the ID of an ad account your TikTok login can manage."
        }
      >
        <FindAdAccountId
          busy={busy === "adding"}
          error={errorText}
          onSubmit={addAccount}
          onCancel={state.needs === "paste" ? undefined : () => { clearError(); setMode("view"); }}
        />
        {reconnectButton && <div className="mt-3">{reconnectButton}</div>}
        {state.needs === "paste" && (
          <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-rule pt-4 text-[13px] text-inkMuted">
            <span>Just added it to a Business Center?</span>
            {searchAgain}
          </div>
        )}
      </Frame>
    );
  }

  if (state.needs === "pick" || mode === "change") {
    return (
      <Frame
        title="Which ad account should Zavi use?"
        intro={`We found ${state.accounts.length} ad accounts on your TikTok login. Zavi proposes changes to the one you choose unless you ask for another, and nothing changes until you approve it.`}
      >
        <ul className="space-y-2" role="radiogroup" aria-label="TikTok ad accounts">
          {state.accounts.map((a) => {
            const current = a.advertiser_id === state.selected_id;
            return (
              <li key={a.advertiser_id}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={current}
                  disabled={busy !== null}
                  onClick={async () => { if (await select(a.advertiser_id)) setMode("view"); }}
                  className={`flex w-full items-center justify-between gap-3 rounded-xl border px-4 py-3 text-left transition-colors disabled:opacity-60 ${current ? "border-ink bg-cream" : "border-rule bg-cream hover:border-inkMuted"}`}
                >
                  <AccountLine a={a} />
                  <span className="shrink-0 text-[13px] font-semibold text-inkMuted">{current ? "In use" : "Use this"}</span>
                </button>
              </li>
            );
          })}
        </ul>
        {errorText && <p role="alert" className="mt-3 text-[13px] text-red-700">{errorText}</p>}
        {reconnectButton && <div className="mt-3">{reconnectButton}</div>}
        <div className="mt-4 flex flex-wrap items-center gap-3 text-[13px] text-inkMuted">
          <button type="button" onClick={() => { clearError(); setMode("add"); }} className="font-semibold text-ink underline underline-offset-2">
            Don&apos;t see it? Add it by ID
          </button>
          {mode === "change" && (
            <button type="button" onClick={() => setMode("view")} className="font-semibold underline underline-offset-2">
              Cancel
            </button>
          )}
        </div>
      </Frame>
    );
  }

  return (
    <section className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-rule bg-creamDeep px-5 py-4" aria-label="TikTok ad account" data-testid="tiktok-ad-account">
      <div className="flex min-w-0 items-center gap-3">
        <span className="shrink-0 text-[13px] font-semibold uppercase tracking-wide text-inkMuted">Ad account</span>
        {selected && <AccountLine a={selected} />}
      </div>
      <div className="flex flex-wrap gap-2">
        {state.accounts.length > 1 && (
          <button type="button" onClick={() => setMode("change")} className={btn.secondary}>
            Change
          </button>
        )}
        <button type="button" onClick={() => { clearError(); setMode("add"); }} className={btn.secondary}>
          Add another
        </button>
      </div>
      {errorText && <p role="alert" className="w-full text-[13px] text-red-700">{errorText}</p>}
      {reconnectButton}
    </section>
  );
}
