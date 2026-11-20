import { describe, it, expect } from 'vitest';
import {
  previewPanelState,
  pollIntervalFor,
  humanizePreviewError,
  POLL_MS_STARTING,
  POLL_MS_LIVE,
} from './previewPanelState';

describe('previewPanelState', () => {
  it('renders NOTHING for status "none" (the default-OFF fleet case)', () => {
    expect(previewPanelState({ status: 'none' })).toEqual({ kind: 'hidden' });
  });

  it('renders nothing for a null/absent response or an unknown status', () => {
    expect(previewPanelState(null)).toEqual({ kind: 'hidden' });
    expect(previewPanelState(undefined)).toEqual({ kind: 'hidden' });
    expect(previewPanelState({ status: 'something_new' })).toEqual({ kind: 'hidden' });
  });

  it('shows the spinner while starting', () => {
    expect(previewPanelState({ status: 'starting' })).toEqual({ kind: 'starting' });
  });

  it('goes live only when a proxy_url is actually present', () => {
    expect(previewPanelState({ status: 'live', proxy_url: '/api/x?__pt=t' })).toEqual({
      kind: 'live',
      proxyUrl: '/api/x?__pt=t',
      path: null,
      outcome: null,
    });
    expect(
      previewPanelState({
        status: 'live',
        proxy_url: '/api/x?__pt=t',
        preview_path: '/tutor/bookings',
        preview_outcome: 'on_target',
      }),
    ).toEqual({
      kind: 'live',
      proxyUrl: '/api/x?__pt=t',
      path: '/tutor/bookings',
      outcome: 'on_target',
    });
    expect(previewPanelState({ status: 'live' })).toEqual({ kind: 'hidden' });
  });

  it('shows an EXPIRED card (never a live iframe) for a dead preview', () => {
    const panel = previewPanelState({
      status: 'dead',
      preview_error: 'idle_15min',
      ended_at: '2026-07-14T10:00:00Z',
      can_restart: true,
    });
    expect(panel.kind).toBe('expired');
    if (panel.kind !== 'expired') throw new Error('unreachable');
    expect(panel.canRestart).toBe(true);
    expect(panel.reason).not.toContain('idle_15min');
  });

  it('hides the Restart button when the sandbox is gone', () => {
    const panel = previewPanelState({
      status: 'dead',
      preview_error: 'restart_failed:sandbox_gone',
      can_restart: false,
    });
    expect(panel).toMatchObject({ kind: 'expired', canRestart: false });
  });

  it('assumes restartable when can_restart is absent (older backend)', () => {
    expect(previewPanelState({ status: 'dead' })).toMatchObject({ canRestart: true });
  });
});

describe('pollIntervalFor', () => {
  it('polls fast while starting and slow once live', () => {
    expect(pollIntervalFor({ kind: 'starting' })).toBe(POLL_MS_STARTING);
    expect(pollIntervalFor({ kind: 'live', proxyUrl: '/x', path: null, outcome: null })).toBe(
      POLL_MS_LIVE,
    );
    expect(pollIntervalFor({ kind: 'hidden' })).toBe(POLL_MS_LIVE);
    expect(POLL_MS_STARTING).toBeLessThan(POLL_MS_LIVE);
  });
});

describe('humanizePreviewError', () => {
  it('never leaks a raw machine token to the user', () => {
    for (const code of [
      'no_node_modules:ERESOLVE',
      'boot_timeout:port_unbound',
      'no_runnable_web_app',
      'restart_failed:sandbox_gone',
      'hard_ceiling_60min',
      'preview_idle_15min',
      'boot_error',
      'something_totally_unknown',
      '',
      null,
      undefined,
    ]) {
      const msg = humanizePreviewError(code);
      expect(msg.length).toBeGreaterThan(0);
      expect(msg).not.toMatch(/_|:/);
    }
  });

  it('explains a dependency-install failure specifically', () => {
    expect(humanizePreviewError('no_node_modules:ENOSPC')).toMatch(/dependencies/i);
  });

  it('tells the user to re-run the engineer when a restart is unrecoverable', () => {
    expect(humanizePreviewError('restart_failed:sandbox_gone')).toMatch(/re-run the engineer/i);
  });
});
