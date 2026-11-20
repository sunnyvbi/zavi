
export type ChannelScanHandle = {
  status: () => { canScan: boolean; running: boolean; blockedWhy: string | null; ready: boolean; loaded?: boolean };
  scan: () => Promise<string | null>;
};

const handles = new Map<string, ChannelScanHandle>();

export function registerChannelScan(slug: string, handle: ChannelScanHandle): () => void {
  handles.set(slug, handle);
  return () => {
    if (handles.get(slug) === handle) handles.delete(slug);
  };
}

export function channelScanHandle(slug: string): ChannelScanHandle | null {
  return handles.get(slug) ?? null;
}
