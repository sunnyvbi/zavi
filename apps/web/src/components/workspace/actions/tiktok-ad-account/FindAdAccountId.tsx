import { useState, type FormEvent, type ReactNode } from "react";
import { Input } from "@/components/ui/Input";
import { btn } from "../../agent/dashboard-ui";
import { ADS_MANAGER_URL, parseAdAccountInput } from "./api";

const EXAMPLE_PREFIX = "ads.tiktok.com/i18n/dashboard?aadvid=";
const EXAMPLE_ID = "7123456789012345678";

function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-ink text-[12px] font-semibold text-cream">{n}</span>
      <div className="min-w-0 flex-1 pt-0.5 text-[14px] leading-6 text-ink">{children}</div>
    </li>
  );
}

export function FindAdAccountId({
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  busy: boolean;
  error: string | null;
  onSubmit: (input: string) => Promise<boolean>;
  onCancel?: () => void;
}) {
  const [value, setValue] = useState("");
  const parsed = parseAdAccountInput(value);
  const typed = value.trim().length > 0;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!parsed || busy) return;
    if (await onSubmit(value)) setValue("");
  };

  return (
    <div className="space-y-4">
      <ol className="space-y-3">
        <Step n={1}>
          Open{" "}
          <a href={ADS_MANAGER_URL} target="_blank" rel="noreferrer" className="font-semibold text-ink underline underline-offset-2">
            TikTok Ads Manager
          </a>{" "}
          and sign in with the same TikTok login you just connected.
        </Step>
        <Step n={2}>
          Look at your browser&apos;s address bar. Your ad account ID is the number after <code className="rounded bg-creamDeep px-1 text-[13px]">aadvid=</code>
          <div className="mt-2 overflow-x-auto rounded-xl border border-rule bg-cream px-3 py-2 font-mono text-[12.5px] text-inkMuted">
            {EXAMPLE_PREFIX}
            <mark className="rounded bg-amber-200/70 px-0.5 text-ink">{EXAMPLE_ID}</mark>
          </div>
        </Step>
        <Step n={3}>Copy the whole address, or just that number, and paste it below.</Step>
      </ol>

      <form onSubmit={submit} className="space-y-2">
        <label htmlFor="tiktok-ad-account-input" className="text-[14px] font-medium text-ink">
          Ads Manager link or ad account ID
        </label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            id="tiktok-ad-account-input"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={`https://${EXAMPLE_PREFIX}…`}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={typed && !parsed}
            aria-describedby="tiktok-ad-account-hint"
          />
          <button type="submit" disabled={!parsed || busy} className={`${btn.primary} shrink-0 whitespace-nowrap`}>
            {busy ? "Checking with TikTok…" : "Check and save"}
          </button>
        </div>
        <p id="tiktok-ad-account-hint" className="text-[13px] leading-5 text-inkMuted" aria-live="polite">
          {!typed
            ? "We check it with TikTok before saving, so only an account your login can manage is accepted."
            : parsed
              ? `Found ad account ID ${parsed}.`
              : "We can't find an ID in that yet. Paste the full address, or only the number after aadvid=."}
        </p>
        {error && (
          <p role="alert" className="rounded-xl border border-red-400/40 bg-red-500/10 px-3 py-2 text-[13px] text-ink">
            {error}
          </p>
        )}
        {onCancel && (
          <button type="button" onClick={onCancel} className="text-[13px] font-semibold text-inkMuted underline underline-offset-2">
            Cancel
          </button>
        )}
      </form>
    </div>
  );
}
