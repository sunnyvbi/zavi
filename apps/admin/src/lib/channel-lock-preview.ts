import { adminApiFetch } from "@/lib/api-admin";

export type LockImpact = {
  running_runs: number;
  schedules: number;
  companies: number;
  schedules_skipped_reason: string | null;
  live_campaigns_note: string | null;
};

export async function readLockPreview(slug: string): Promise<LockImpact | null> {
  try {
    const res = await adminApiFetch(`/api/admin/channel-locks/${encodeURIComponent(slug)}/impact`);
    return res.ok ? ((await res.json()) as LockImpact) : null;
  } catch {
    return null;
  }
}
