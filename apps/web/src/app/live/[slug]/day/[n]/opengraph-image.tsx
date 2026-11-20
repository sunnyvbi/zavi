import { ImageResponse } from "next/og";
import { getLiveUpcar } from "@/lib/marketing/liveUpcar";
import { dayShareCard, type DayShareCard } from "../../_components/dayShareCard";

export const alt = "Zavi runs Upcar's growth, live";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const dynamic = "force-dynamic";

const BG = "#07090d";
const BLUE = "#5aa9ff";

export default async function Image({ params }: { params: { slug: string; n: string } }) {
  let card: DayShareCard | null = null;
  try {
    const data = await getLiveUpcar(params.slug);
    card = data && data !== "not_found" ? dayShareCard(data, params.n) : null;
  } catch {
    card = null;
  }

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          background: BG,
          display: "flex",
          flexDirection: "column",
          padding: "64px 72px",
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
          color: "#ffffff",
        }}
      >
        <div style={{ display: "flex", fontSize: 26, letterSpacing: "0.12em", textTransform: "uppercase", color: BLUE, fontWeight: 700 }}>
          {card ? `Day ${card.n} of ${card.of}` : "Live experiment"}
        </div>
        <div style={{ display: "flex", marginTop: 28, fontSize: card && card.headline.length > 70 ? 50 : 60, fontWeight: 700, lineHeight: 1.15 }}>
          {card ? clip(card.headline, 120) : "An AI runs a real company's growth, in public."}
        </div>
        {card && card.stats.length > 0 && (
          <div style={{ display: "flex", marginTop: 40, gap: 24 }}>
            {card.stats.map((s) => (
              <div
                key={s.label}
                style={{ display: "flex", flexDirection: "column", border: "1px solid rgba(255,255,255,0.18)", borderRadius: 16, padding: "18px 28px" }}
              >
                <div style={{ display: "flex", fontSize: 20, letterSpacing: "0.1em", textTransform: "uppercase", color: "rgba(255,255,255,0.55)" }}>
                  {s.label}
                </div>
                <div style={{ display: "flex", marginTop: 6, fontSize: 52, fontWeight: 700 }}>{s.value}</div>
              </div>
            ))}
          </div>
        )}
        <div style={{ display: "flex", marginTop: "auto", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ display: "flex", fontSize: 24, fontWeight: 600 }}>Zavi runs Upcar&apos;s growth, live</div>
          <div style={{ display: "flex", fontSize: 22, color: "rgba(255,255,255,0.6)" }}>zaviagent.com</div>
        </div>
      </div>
    ),
    size,
  );
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
}
