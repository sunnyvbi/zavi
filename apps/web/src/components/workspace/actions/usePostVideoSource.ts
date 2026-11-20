import { useEffect, useState } from "react";
import { z } from "zod";
import { campaignFetch } from "./managed-campaigns/api";

const response = z.object({ signed_url: z.string().url().refine((url) => url.startsWith("https://")) });
export function usePostVideoSource(source: string) {
  const privatePath = /^[a-f0-9-]{36}\/[a-f0-9-]{36}\.mp4$/.test(source);
  const [read, setRead] = useState<{ source: string; url: string | null; error: string } | null>(null);
  useEffect(() => {
    if (!privatePath) return;
    let stopped = false;
    void campaignFetch<unknown>(`/api/channel-actions/post-draft/video?path=${encodeURIComponent(source)}`).then((value) => {
      const result = response.parse(value);
      if (!stopped) setRead({ source, url: result.signed_url, error: "" });
    }).catch(() => { if (!stopped) setRead({ source, url: null, error: "The video could not be loaded. Refresh to try again." }); });
    return () => { stopped = true; };
  }, [source, privatePath]);
  const current = read?.source === source ? read : null;
  return { url: privatePath ? current?.url : source.startsWith("https://") ? source : null, error: current?.error };
}
