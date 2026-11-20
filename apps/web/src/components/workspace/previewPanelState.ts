
export type PreviewStatus = 'none' | 'starting' | 'live' | 'dead' | string;

export type PreviewOutcome = 'on_target' | 'off_target';

export type PreviewStatusResponse = {
  status: PreviewStatus;
  proxy_url?: string;
  preview_error?: string | null;
  ended_at?: string | null;
  can_restart?: boolean;
  preview_path?: string | null;
  preview_outcome?: PreviewOutcome | null;
};

export type PreviewPanel =
  | { kind: 'hidden' }
  | { kind: 'starting' }
  | { kind: 'live'; proxyUrl: string; path: string | null; outcome: PreviewOutcome | null }
  | { kind: 'expired'; reason: string; canRestart: boolean };

export const POLL_MS_STARTING = 5_000;
export const POLL_MS_LIVE = 30_000;

export function pollIntervalFor(panel: PreviewPanel): number {
  return panel.kind === 'starting' ? POLL_MS_STARTING : POLL_MS_LIVE;
}

export function previewPanelState(
  res: PreviewStatusResponse | null | undefined,
): PreviewPanel {
  if (!res) return { kind: 'hidden' };

  if (res.status === 'live' && res.proxy_url) {
    return {
      kind: 'live',
      proxyUrl: res.proxy_url,
      path: res.preview_path ?? null,
      outcome:
        res.preview_outcome === 'on_target' || res.preview_outcome === 'off_target'
          ? res.preview_outcome
          : null,
    };
  }
  if (res.status === 'starting') return { kind: 'starting' };
  if (res.status === 'dead') {
    return {
      kind: 'expired',
      reason: humanizePreviewError(res.preview_error),
      canRestart: res.can_restart !== false,
    };
  }
  return { kind: 'hidden' };
}

export function humanizePreviewError(code: string | null | undefined): string {
  const c = (code ?? '').trim();
  if (!c) return 'This preview is no longer running.';

  if (c.startsWith('no_node_modules')) {
    return "The preview couldn't start because its dependencies failed to install.";
  }
  if (c.startsWith('boot_timeout') || c === 'boot_orchestration_timeout') {
    return "The preview's dev server took too long to start.";
  }
  if (c === 'no_runnable_web_app') {
    return 'No runnable web app was found in this repo.';
  }
  if (c.startsWith('restart_failed')) {
    return "This preview couldn't be restarted. Re-run the engineer to rebuild it.";
  }
  if (c.startsWith('idle_') || c.startsWith('preview_idle_')) {
    return 'The preview was paused after sitting idle.';
  }
  if (c.startsWith('hard_ceiling') || c.startsWith('stuck_starting')) {
    return 'The preview reached its time limit and was paused.';
  }
  if (c.startsWith('boot_error') || c === 'preview_disabled') {
    return "The preview couldn't start.";
  }
  return 'This preview is no longer running.';
}
