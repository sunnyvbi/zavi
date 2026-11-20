import { ImageResponse } from "next/og";

export const runtime = "edge";
export const alt = "Zavi: AI Growth Agent For Your Business";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OG() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          background: "#FAF7F2",
          display: "flex",
          flexDirection: "column",
          padding: "72px 80px",
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
        }}
      >
        {}
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <svg width="44" height="44" viewBox="0 0 24 24">
            <rect x="3" y="4"  width="18" height="4" rx="1.5" fill="#0A1F3A" />
            <rect x="3" y="10" width="13" height="4" rx="1.5" fill="#0A1F3A" fillOpacity="0.55" />
            <rect x="3" y="16" width="8"  height="4" rx="1.5" fill="#191919" />
          </svg>
          <div style={{ fontSize: 36, fontWeight: 700, color: "#0A1F3A", letterSpacing: "-0.04em" }}>
            zavi
          </div>
        </div>

        {}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            marginTop: "auto",
            color: "#0A1F3A",
            fontSize: 84,
            fontWeight: 700,
            letterSpacing: "-0.045em",
            lineHeight: 1.0,
          }}
        >
          <div>AI Growth Agent</div>
          {}
          <div style={{ display: "flex" }}>
            For Your<span style={{ color: "#191919", fontStyle: "italic", marginLeft: "0.25em" }}>Business</span>
          </div>
        </div>

        {}
        <div
          style={{
            display: "flex",
            marginTop: 28,
            fontSize: 24,
            color: "#475569",
            lineHeight: 1.4,
            maxWidth: 760,
          }}
        >
          Zavi reads your business, writes the growth plan, runs the channels and tells you what changed.
        </div>

        {}
        <div
          style={{
            display: "flex",
            marginTop: 28,
            fontSize: 14,
            color: "#191919",
            letterSpacing: "0.16em",
            textTransform: "uppercase",
            fontFamily: "ui-monospace, monospace",
          }}
        >
          zaviagent.com
        </div>
      </div>
    ),
    size,
  );
}
