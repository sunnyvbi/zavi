import { ImageResponse } from "next/og";
import { getStartCard } from "@/lib/start-card/api";

export const alt = "Zavi growth check";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const dynamic = "force-dynamic";

const INK = "#0A1F3A";
const BLUE = "#027bff";
const RING_R = 96;
const RING_C = 2 * Math.PI * RING_R;

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let card = null;
  try {
    card = await getStartCard(id, { cache: "no-store" });
  } catch {
    card = null;
  }
  const visible = card && card.status !== "removed" && card.status !== "expired" ? card : null;
  const score = visible?.score ?? null;
  const diagnosis = visible?.parts?.diagnosis?.state === "done" ? visible.parts.diagnosis.evidence : null;
  const pct = score && score.out_of > 0 ? Math.round((score.total / score.out_of) * 100) : 0;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          background: "#FAF7F2",
          display: "flex",
          flexDirection: "column",
          padding: "64px 72px",
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
          color: INK,
        }}
      >
        <div style={{ display: "flex", fontSize: 26, color: "#475569" }}>
          {visible ? `Growth check · ${visible.domain}` : "Zavi growth check"}
        </div>

        <div style={{ display: "flex", alignItems: "center", marginTop: 48, gap: 48 }}>
          {}
          <div style={{ position: "relative", width: 220, height: 220, display: "flex" }}>
            <svg width="220" height="220" viewBox="0 0 220 220">
              <circle cx="110" cy="110" r={RING_R} stroke="#e3e6ea" strokeWidth="22" fill="none" />
              {score && pct > 0 && (
                <circle
                  cx="110"
                  cy="110"
                  r={RING_R}
                  stroke={BLUE}
                  strokeWidth="22"
                  fill="none"
                  strokeLinecap="round"
                  strokeDasharray={`${(RING_C * pct) / 100} ${RING_C}`}
                  transform="rotate(-90 110 110)"
                />
              )}
            </svg>
            <div
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: 220,
                height: 220,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <div style={{ display: "flex", fontSize: 76, fontWeight: 700, lineHeight: 1 }}>
                {score ? String(score.total) : "?"}
              </div>
              <div style={{ display: "flex", fontSize: 22, color: "#64748b" }}>
                {score ? `out of ${score.out_of}` : "out of 100"}
              </div>
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
            <div
              style={{ display: "flex", fontSize: 20, letterSpacing: "0.12em", textTransform: "uppercase", color: "#64748b" }}
            >
              {diagnosis ? "#1 thing holding it back" : "What's your growth score?"}
            </div>
            <div style={{ display: "flex", marginTop: 14, fontSize: 46, fontWeight: 700, lineHeight: 1.15 }}>
              {diagnosis
                ? clip(diagnosis.constraint.title, 90)
                : "Google, AI answers, SEO, design and competitors, checked for free."}
            </div>
          </div>
        </div>

        <div style={{ display: "flex", marginTop: "auto", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ display: "flex", fontSize: 24, fontWeight: 600 }}>Made with Zavi</div>
          <div style={{ display: "flex", fontSize: 22, color: "#475569" }}>zaviagent.com</div>
        </div>
      </div>
    ),
    size,
  );
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
}
