import { ImageResponse } from "next/og";
import { siteCardColour, siteCardParams } from "@/lib/siteCard";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const { name, host } = siteCardParams(new URL(request.url).searchParams);
  const colour = siteCardColour(name);
  const initial = (name.match(/[A-Za-z0-9]/)?.[0] ?? "W").toUpperCase();
  const response = new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "80px 88px",
          background: "#FAF7F2",
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
        }}
      >
        <div
          style={{
            width: 112,
            height: 112,
            borderRadius: 26,
            background: colour,
            color: "#ffffff",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 64,
            fontWeight: 700,
          }}
        >
          {initial}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <div style={{ fontSize: name.length > 30 ? 64 : 84, fontWeight: 700, color: "#0e0f11", letterSpacing: "-0.03em", lineHeight: 1.05 }}>
            {name}
          </div>
          {host ? <div style={{ fontSize: 30, color: "#5b6168" }}>{host}</div> : null}
        </div>
        <div style={{ height: 10, width: 160, borderRadius: 5, background: colour }} />
      </div>
    ),
    { width: 1200, height: 630 },
  );
  response.headers.set("Cache-Control", "public, max-age=86400, s-maxage=604800");
  return response;
}
