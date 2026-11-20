import type { Metadata } from "next";
import { apiUrl } from "@/lib/api";
import { parseLiveUpcar, type PublicDay } from "@/lib/marketing/liveUpcar";
import { ReviewForm } from "./ReviewForm";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Review mission log · Zavi", robots: { index: false, follow: false } };

type Review = { day: string; full: PublicDay; neutral: PublicDay; expires_at: string };

async function loadReview(slug: string, day: string, t: string): Promise<Review | null> {
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(slug)) return null;
  try {
    const res = await fetch(apiUrl(`/api/public/live/${slug}/review/${encodeURIComponent(day)}?t=${encodeURIComponent(t)}`), { cache: "no-store" });
    if (!res.ok) return null;
    const j = (await res.json()) as Record<string, unknown>;
    const one = (e: unknown) => parseLiveUpcar({ locked: false, days: [{ ...(e as object), day }] })?.days[0] ?? null;
    const full = one(j.full);
    const neutral = one(j.neutral);
    if (!full || !neutral) return null;
    return { day, full, neutral, expires_at: String(j.expires_at ?? "") };
  } catch {
    return null;
  }
}

export default async function ReviewPage(
  props: { params: Promise<{ slug: string; day: string }>; searchParams: Promise<{ t?: string }> }
) {
  const searchParams = await props.searchParams;
  const params = await props.params;
  const t = typeof searchParams.t === "string" ? searchParams.t : "";
  const review = t ? await loadReview(params.slug, params.day, t) : null;
  return (
    <main className="min-h-screen bg-[#fbfbfa] px-4 py-12 text-[#0e0f11] sm:px-6">
      <div className="mx-auto max-w-[720px]">
        <p className="font-mono text-[11px] tracking-[0.12em] text-[#6b7076] uppercase">Mission log · review</p>
        {review ? (
          <ReviewForm slug={params.slug} day={review.day} token={t} full={review.full} neutral={review.neutral} expiresAt={review.expires_at} />
        ) : (
          <p className="mt-4 text-[16px]">This link has expired or is not valid. A new one comes with tonight&apos;s draft.</p>
        )}
      </div>
    </main>
  );
}
