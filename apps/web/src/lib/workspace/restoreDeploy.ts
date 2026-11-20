import { apiFetch } from "@/lib/api";
import { toast } from "@/components/ui/toast";

export const RESTORE_POLL_MS = 5000;
export const RESTORE_MAX_POLLS = 144;

export type RestoreDeployOutcome = "live" | "failed" | "timeout" | "cancelled";

export function shortVersionTitle(title: string, max = 56): string {
  const t = title.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1).trimEnd()}…`;
}

export type DeployWatchCopy = {
  loading: string;
  loadingDetail: string;
  live: string;
  liveDetail: string;
  failed: string;
  failedDetail: string;
  timeoutDetail: string;
};

function revertCopy(name: string): DeployWatchCopy {
  return {
    loading: "Reverting to an earlier version",
    loadingDetail: `“${name}” is redeploying. This usually takes a couple of minutes.`,
    live: "Reverted",
    liveDetail: `Your app is live as “${name}”.`,
    failed: "The revert didn't deploy",
    failedDetail: "Your app kept its previous version. Try again, or ask Zavi to fix the build.",
    timeoutDetail: "The revert is taking longer than usual. Reload in a few minutes to see it.",
  };
}

export function publishCopy(count: number): DeployWatchCopy {
  const what = count === 1 ? "1 change" : `${count} changes`;
  return {
    loading: "Publishing",
    loadingDetail: `${what} going live. This usually takes a couple of minutes.`,
    live: "Published",
    liveDetail: count === 1 ? "1 change is live on your app." : `${what} are live on your app.`,
    failed: "The publish didn't deploy",
    failedDetail: "Your live app kept its previous version. Your changes are saved in your app's code and go live with the next successful deploy.",
    timeoutDetail: "Publishing is taking longer than usual. Reload in a few minutes to see it.",
  };
}

export async function watchRestoreDeploy(args: {
  commitSha: string;
  title: string;
  onLive: () => void;
  sleep?: (ms: number) => Promise<void>;
  copy?: DeployWatchCopy;
  signal?: AbortSignal;
}): Promise<RestoreDeployOutcome> {
  const sleep = args.sleep ?? ((ms) => new Promise<void>((r) => window.setTimeout(r, ms)));
  const copy = args.copy ?? revertCopy(shortVersionTitle(args.title));
  const id = toast.add({
    type: "loading",
    title: copy.loading,
    description: copy.loadingDetail,
    dismissible: false,
    timeout: 0,
  });
  const cancelled = () => {
    toast.close(id);
    return "cancelled" as const;
  };
  for (let i = 0; i < RESTORE_MAX_POLLS; i += 1) {
    if (args.signal?.aborted) return cancelled();
    await sleep(RESTORE_POLL_MS);
    if (args.signal?.aborted) return cancelled();
    let state = "deploying";
    try {
      const res = await apiFetch(`/api/workspace/autopilot/restore-status?commit_sha=${encodeURIComponent(args.commitSha)}`, {
        signal: args.signal,
      });
      if (res.ok) {
        const j = (await res.json()) as { state?: string };
        state = j.state ?? "deploying";
      }
    } catch {
      state = "deploying";
    }
    if (args.signal?.aborted) return cancelled();
    if (state === "live") {
      toast.update(id, { type: "success", title: copy.live, description: copy.liveDetail });
      args.onLive();
      return "live";
    }
    if (state === "failed") {
      toast.update(id, { type: "error", title: copy.failed, description: copy.failedDetail });
      return "failed";
    }
  }
  toast.update(id, { type: "info", title: "Still deploying", description: copy.timeoutDetail });
  return "timeout";
}
