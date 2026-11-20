import { useEffect, useState } from "react";
import { z } from "zod";
import { adReviewPresentationSchema, type AdReviewResponse } from "@zavi/shared";
import { campaignFetch } from "../managed-campaigns/api";

const resultSchema = z.object({ review: adReviewPresentationSchema.nullable() });
export function useAdDraftPreview(actionId: string | undefined, review: AdReviewResponse, values: Record<string, string>) {
  const edits = Object.fromEntries(review.fields.filter((field) => (field.key === "tweet_ids" || field.key === "creative.post_urn") && values[field.key] !== undefined && values[field.key] !== field.value).map((field) => [field.key, values[field.key]]));
  const needsSource = Object.keys(edits).some((key) => key === "tweet_ids" || key === "creative.post_urn");
  const signature = needsSource ? JSON.stringify({ revision: review.review?.revision, changes: edits }) : "";
  const [result, setResult] = useState<{ signature: string; review: AdReviewResponse["review"]; error: string } | null>(null);
  useEffect(() => {
    if (!actionId || !signature) return;
    let stopped = false;
    const timer = setTimeout(() => {
      void campaignFetch<unknown>(`/api/channel-actions/${encodeURIComponent(actionId)}/ad-review/preview`, { method: "POST", body: signature }).then((value) => {
        const parsed = resultSchema.parse(value);
        if (!stopped) setResult({ signature, review: parsed.review, error: "" });
      }).catch((error) => { if (!stopped) setResult({ signature, review: null, error: error instanceof Error ? error.message : "Could not resolve this source." }); });
    }, 350);
    return () => { stopped = true; clearTimeout(timer); };
  }, [actionId, signature]);
  const current = result?.signature === signature ? result : null;
  return { review: current?.review, loading: !!signature && !!actionId && !current, error: current?.error };
}
