import { useEffect, useState } from "react";
import { campaignFetch } from "../managed-campaigns/api";

const ARTIFACT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function useArtifactImagePreview(artifactId: string | null | undefined) {
  const id = artifactId && ARTIFACT_ID_RE.test(artifactId) ? artifactId : null;
  const [result, setResult] = useState<{ id: string; src: string | null; failed: boolean } | null>(null);
  useEffect(() => {
    if (!id) return;
    let stale = false;
    void campaignFetch<{ signed_url?: string }>(`/api/run-artifacts/${encodeURIComponent(id)}/url`)
      .then((response) => {
        const src = typeof response.signed_url === "string" && /^https:\/\//i.test(response.signed_url) ? response.signed_url : null;
        if (!stale) setResult({ id, src, failed: !src });
      })
      .catch(() => { if (!stale) setResult({ id, src: null, failed: true }); });
    return () => { stale = true; };
  }, [id]);
  const current = result?.id === id ? result : null;
  return { src: id ? current?.src ?? null : null, failed: id ? current?.failed ?? false : false, loading: !!id && !current };
}
