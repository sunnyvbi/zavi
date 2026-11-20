import React from "react";
import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame, Easing } from "remotion";
import { SANS, MONO, SERIF } from "./fonts";

export const W = 1920, H = 1080;

export const CREAM = "#F7F6F3", CREAM_DEEP = "#EFEDE7", BONE = "#E4E1D8";
export const INK = "#191919", INK_SOFT = "#2B2A28", INK_MUTED = "#787268";
export const RULE = "#D8D4C8", WHITE = "#FFFFFF";
export const MARIGOLD = "#FFC93D", MINT = "#A3D9C0", CORAL = "#FF6B6B";
export const MINT_DEEP = "#0E9F6E", SUCCESS = "#167F50", DANGER = "#CB2029";

export const BRAND: Record<string, string> = {
  gads: "#3C8BD9", meta: "#0866FF", reddit: "#FF4500", tiktok: "#111111",
  linkedin: "#0073B2", youtube: "#ED1D24", instagram: "#E1306C", github: "#24292E",
  whatsapp: "#25D366", slack: "#611F69", telegram: "#26A5E4", google: "#4285F4",
};

export const ez = (f: number, a: number, b: number) =>
  interpolate(f, [a, b], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.22, 0.61, 0.36, 1) });

export const fast = (f: number, i: number) => ez(f, i * 1.5, 8 + i * 1.5);

export const br = (f: number, seed: number, amp = 1, period = 34) =>
  Math.sin((f + seed * 13) / (period / (2 * Math.PI))) * amp;

export const drift = (f: number, base: number, amp = 0.004, seed = 0) =>
  base * (1 + Math.sin((f + seed * 17) / 21) * amp);

export const Stage: React.FC<{ dur: number; bg?: string; push?: number; children: React.ReactNode }> = ({ dur, bg = CREAM, push = 1.024, children }) => {
  const f = useCurrentFrame();
  const k = interpolate(f, [0, dur], [1, push], { extrapolateRight: "clamp" });
  const fade = Math.max(2, Math.min(5, Math.round(dur * 0.06)));
  const o = Math.min(ez(f, 0, fade), 1 - ez(f, dur - fade, dur));
  return (
    <AbsoluteFill style={{ background: bg, fontFamily: SANS, color: INK, overflow: "hidden" }}>
      <AbsoluteFill style={{ opacity: o, transform: `scale(${k})`, transformOrigin: "50% 48%" }}>{children}</AbsoluteFill>
    </AbsoluteFill>
  );
};

export const Logo: React.FC<{ f: string; s?: number; o?: number }> = ({ f, s = 32, o = 1 }) => (
  <Img src={staticFile(`logos/${f}`)} style={{ width: s, height: s, objectFit: "contain", display: "block", flex: "none", opacity: o }} />
);

export const Mono: React.FC<{ children: React.ReactNode; s?: number; c?: string; ls?: number }> = ({ children, s = 12.5, c = INK_MUTED, ls = 1.1 }) => (
  <span style={{ fontFamily: MONO, fontSize: s, letterSpacing: ls, textTransform: "uppercase", color: c, fontWeight: 500 }}>{children}</span>
);

export const Mascot: React.FC<{ pose?: string; s?: number; x?: number; y?: number; rot?: number }> = ({ pose = "zavi-front-512", s = 200, x, y, rot = 0 }) => {
  const f = useCurrentFrame();
  const g = fast(f, 0);
  return (
    <Img
      src={staticFile(`mascot/${pose}.png`)}
      style={{
        position: x === undefined ? "relative" : "absolute", left: x, top: y,
        width: s, height: s, objectFit: "contain", display: "block", flex: "none",
        opacity: g,
        transform: `translateY(${(1 - g) * 18 + br(f, 3, 4, 52)}px) rotate(${rot + br(f, 7, 1.1, 64)}deg) scale(${0.97 + 0.03 * g})`,
      }}
    />
  );
};

export const Phone: React.FC<{ x: number; y: number; h?: number; title?: string; sub?: string; children: React.ReactNode }> = ({ x, y, h = 880, title = "Zavi", sub = "online", children }) => {
  const f = useCurrentFrame();
  const g = fast(f, 0);
  const w = Math.round(h * 0.485);
  return (
    <div style={{
      position: "absolute", left: x, top: y, width: w, height: h,
      borderRadius: 46, background: "#0B141A", border: `10px solid ${INK}`,
      boxShadow: "0 40px 90px -40px rgba(0,0,0,.55)", overflow: "hidden",
      opacity: g, transform: `translateY(${(1 - g) * 26}px)`,
    }}>
      <div style={{ height: 78, background: "#075E54", display: "flex", alignItems: "center", gap: 12, padding: "0 16px" }}>
        <Img src={staticFile("mascot/zavi-front-512.png")} style={{ width: 46, height: 46, borderRadius: 99, background: CREAM, objectFit: "contain" }} />
        <div>
          <div style={{ color: "#FFFFFF", fontSize: 19, fontWeight: 650 }}>{title}</div>
          <div style={{ color: "#BFE3D6", fontSize: 13 }}>{sub}</div>
        </div>
        {}
        <span style={{ width: 10, height: 10, borderRadius: 99, background: "#BFE3D6", opacity: 0.8, flex: "none" }} />
      </div>
      <div style={{ position: "absolute", inset: "78px 0 72px 0", background: "#0B141A", padding: "14px 12px", display: "flex", flexDirection: "column", gap: 10 }}>
        {children}
      </div>
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 72, background: "#0B141A", display: "flex", alignItems: "center", gap: 10, padding: "0 14px" }}>
        <div style={{ flex: 1, height: 46, borderRadius: 99, background: "#1F2C34", display: "flex", alignItems: "center", padding: "0 16px", color: "#7C8A93", fontSize: 15 }}>
          Message
        </div>
        <span style={{ width: 46, height: 46, borderRadius: 99, background: "#00A884", display: "grid", placeItems: "center", color: "#0B141A", fontSize: 19, fontWeight: 800 }}>↑</span>
      </div>
    </div>
  );
};

export const Bubble: React.FC<{ side: "me" | "zavi"; at: number; t: string; time?: string; dark?: boolean; w?: number; s?: number }> = ({ side, at, t, time, dark = true, w = 330, s = 17 }) => {
  const f = useCurrentFrame();
  const g = ez(f, at, at + 9);
  const me = side === "me";
  const bg = dark ? (me ? "#005C4B" : "#1F2C34") : (me ? INK : WHITE);
  const fg = dark ? "#E9EDEF" : (me ? CREAM : INK);
  return (
    <div style={{ display: "flex", justifyContent: me ? "flex-end" : "flex-start", opacity: g, transform: `translateY(${(1 - g) * 14}px)` }}>
      <div style={{
        maxWidth: w, background: bg, color: fg, borderRadius: 14,
        borderTopRightRadius: me ? 3 : 14, borderTopLeftRadius: me ? 14 : 3,
        padding: "9px 12px 6px", fontSize: s, lineHeight: 1.36, fontWeight: 450,
        border: dark ? "none" : `1px solid ${RULE}`,
      }}>
        {t}
        {time ? <div style={{ fontSize: 11.5, opacity: 0.55, textAlign: "right", marginTop: 3 }}>{time}</div> : null}
      </div>
    </div>
  );
};

export const SlackPane: React.FC<{ x: number; y: number; w: number; h: number; channel: string; children: React.ReactNode }> = ({ x, y, w, h, channel, children }) => {
  const f = useCurrentFrame();
  const g = fast(f, 0);
  return (
    <div style={{
      position: "absolute", left: x, top: y, width: w, height: h, borderRadius: 16,
      background: WHITE, border: `1px solid ${RULE}`, overflow: "hidden",
      boxShadow: "0 30px 70px -44px rgba(0,0,0,.35)", opacity: g, transform: `translateY(${(1 - g) * 16}px)`,
    }}>
      <div style={{ height: 58, background: BRAND.slack, display: "flex", alignItems: "center", gap: 11, padding: "0 20px" }}>
        <Logo f="slack-color.svg" s={22} />
        <span style={{ color: "#FFFFFF", fontSize: 19, fontWeight: 700 }}>#{channel}</span>
        <span style={{ color: "#D9C9DD", fontSize: 14, marginLeft: 6 }}>Northbound Coffee</span>
        <span style={{ marginLeft: "auto", width: 9, height: 9, borderRadius: 99, background: MINT, opacity: 0.4 + 0.6 * Math.abs(Math.sin(f / 15)) }} />
      </div>
      <div style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 13 }}>{children}</div>
    </div>
  );
};

export const FactRow: React.FC<{ at: number; fact: string; src: string; s?: number }> = ({ at, fact, src, s = 22 }) => {
  const f = useCurrentFrame();
  const g = ez(f, at, at + 11);
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 12, padding: "11px 0", borderBottom: `1px solid ${RULE}`, opacity: g, transform: `translateX(${(1 - g) * 16}px)` }}>
      <span style={{ width: 7, height: 7, borderRadius: 99, background: MINT_DEEP, flex: "none", transform: "translateY(-3px)", opacity: 0.35 + 0.65 * Math.abs(Math.sin((f + at * 4) / 17)) }} />
      <span style={{ fontSize: s, lineHeight: 1.4, color: INK_SOFT, fontWeight: 460, flex: 1 }}>{fact}</span>
      <span style={{ fontSize: s * 0.72, color: INK_MUTED, textDecoration: "underline", textUnderlineOffset: 3, whiteSpace: "nowrap" }}>{src}</span>
    </div>
  );
};

export const Tile: React.FC<{
  at: number; label: string; value: string; delta?: string; up?: boolean; caption?: string;
  unverified?: boolean; s?: number; live?: number; suf?: string; pre?: string; sel?: boolean;
}> = ({ at, label, value, delta, up, caption, unverified, s = 34, live, suf = "", pre = "", sel }) => {
  const f = useCurrentFrame();
  const g = ez(f, at, at + 10);
  const shown = live === undefined ? value : pre + Math.round(drift(f, live, 0.005, at) * interpolate(f, [at, at + 20], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })).toLocaleString() + suf;
  const dc = up ? SUCCESS : DANGER;
  return (
    <div style={{
      flex: 1, borderRadius: 16, background: sel ? BONE : CREAM, border: `1px solid ${sel ? INK : RULE}`,
      padding: "14px 16px", opacity: g, transform: `translateY(${(1 - g) * 12}px)`, minWidth: 0,
    }}>
      <div style={{ fontSize: s * 0.36, color: INK_MUTED, fontWeight: 560, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{label}</div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 9, marginTop: 4 }}>
        <span style={{ fontSize: s, fontWeight: 780, letterSpacing: -s * 0.032, fontVariantNumeric: "tabular-nums" }}>{shown}</span>
        {delta ? <span style={{ fontSize: s * 0.4, fontWeight: 680, color: dc }}>{delta}</span> : null}
      </div>
      {caption ? <div style={{ fontSize: s * 0.36, color: INK_MUTED, marginTop: 2, lineHeight: 1.3 }}>{caption}</div> : null}
      {unverified ? (
        <div style={{ marginTop: 7, display: "inline-flex", alignItems: "center", gap: 6, background: BONE, borderRadius: 6, padding: "3px 8px" }}>
          <span style={{ width: 6, height: 6, borderRadius: 99, background: MARIGOLD }} />
          <Mono s={s * 0.3} c={INK_SOFT}>unverified</Mono>
        </div>
      ) : null}
    </div>
  );
};

export const Spark: React.FC<{ w?: number; h?: number; c?: string; seed?: number; down?: boolean }> = ({ w = 170, h = 34, c = MINT_DEEP, seed = 1, down }) => {
  const f = useCurrentFrame();
  const n = 26;
  const pts = Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1);
    const wave = Math.sin((i * 0.8) + (f + seed * 11) / 7) * 0.22 + Math.sin(i * 1.9 + seed) * 0.12;
    const slope = down ? 0.62 - t * 0.42 : 0.28 + t * 0.44;
    return `${(t * w).toFixed(1)},${(h - (slope + wave * 0.5) * h).toFixed(1)}`;
  }).join(" ");
  const head = ez(f, 0, 16);
  return (
    <svg width={w} height={h} style={{ display: "block", overflow: "visible" }}>
      <polyline points={pts} fill="none" stroke={c} strokeWidth={2.4} strokeLinejoin="round" strokeLinecap="round"
        strokeDasharray={w * 2} strokeDashoffset={(1 - head) * w * 2} opacity={0.9} />
    </svg>
  );
};

export const Switch: React.FC<{ on: boolean; at?: number; s?: number; flipAt?: number }> = ({ on, at = 0, s = 1, flipAt }) => {
  const f = useCurrentFrame();
  const live = flipAt !== undefined ? f >= flipAt : on;
  const k = flipAt !== undefined ? ez(f, flipAt, flipAt + 10) : (on ? 1 : 0);
  const w = 52 * s, h = 30 * s;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", width: w, height: h, borderRadius: 99, flex: "none",
      background: live ? INK : BONE, border: `1.5px solid ${live ? INK : RULE}`, padding: 3 * s,
      opacity: ez(f, at, at + 9), transition: "none",
    }}>
      <span style={{
        width: h - 8 * s, height: h - 8 * s, borderRadius: 99, background: live ? CREAM : WHITE,
        transform: `translateX(${k * (w - h) }px)`, boxShadow: "0 1px 3px rgba(0,0,0,.25)",
      }} />
    </span>
  );
};

export const Rank: React.FC<{ n: number; c: string; s?: number; at?: number }> = ({ n, c, s = 44, at = 0 }) => {
  const f = useCurrentFrame();
  const g = ez(f, at, at + 10);
  return (
    <span style={{
      width: s, height: s, borderRadius: 12, flex: "none", display: "grid", placeItems: "center",
      background: `${c}2E`, border: `1.5px solid ${c}`, color: INK,
      fontFamily: SERIF, fontSize: s * 0.52, fontWeight: 600,
      opacity: g, transform: `scale(${0.82 + 0.18 * g})`,
    }}>{n}</span>
  );
};

export const ChanRow: React.FC<{
  at: number; n: number; logo?: string; badge?: string; c: string; name: string;
  picked?: string; why?: string; lastRan?: string; on?: boolean; flipAt?: number;
  dim?: number; lift?: number; s?: number; open?: boolean;
}> = ({ at, n, logo, badge, c, name, picked = "Zavi picked this", why, lastRan, on = false, flipAt, dim = 1, lift = 0, s = 1, open }) => {
  const f = useCurrentFrame();
  const g = ez(f, at, at + 12);
  const reveal = open ? ez(f, at + 6, at + 22) : 0;
  return (
    <div style={{
      display: "flex", alignItems: "flex-start", gap: 16 * s, padding: `${15 * s}px ${20 * s}px`,
      borderRadius: 14 * s, background: lift ? WHITE : "transparent",
      border: `1.5px solid ${lift ? c : "transparent"}`,
      borderBottom: lift ? `1.5px solid ${c}` : `1px solid ${RULE}`,
      opacity: dim * g, transform: `translateX(${(1 - g) * 18}px) translateY(${-lift * 6}px) scale(${1 + lift * 0.012})`,
      boxShadow: lift ? `0 22px 46px -28px ${c}` : "none",
    }}>
      <Rank n={n} c={c} s={44 * s} at={at + 2} />
      {logo ? <Logo f={logo} s={30 * s} /> : (
        <span style={{ width: 30 * s, height: 30 * s, borderRadius: 8, background: c, color: INK, display: "grid", placeItems: "center", fontSize: 15 * s, fontWeight: 800, flex: "none" }}>{badge}</span>
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 24 * s, fontWeight: 700, letterSpacing: -0.4 * s }}>{name}</div>
        <div style={{ fontSize: 15 * s, color: INK_MUTED, marginTop: 2 * s }}>
          {picked}{lastRan ? ` · last ran ${lastRan}` : ""}
        </div>
        {why ? (
          <div style={{ overflow: "hidden", height: open ? reveal * (78 * s) : 0, opacity: reveal }}>
            <div style={{ marginTop: 9 * s, borderLeft: `3px solid ${c}`, paddingLeft: 13 * s }}>
              <Mono s={11.5 * s}>Why this channel</Mono>
              <div style={{ fontSize: 18 * s, lineHeight: 1.42, color: INK_SOFT, marginTop: 3 * s }}>{why}</div>
            </div>
          </div>
        ) : null}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 11 * s, flex: "none", paddingTop: 4 * s }}>
        <span style={{ fontSize: 15 * s, color: INK_MUTED, fontWeight: 560 }}>Runs on its own</span>
        <Switch on={on} flipAt={flipAt} at={at + 4} s={s} />
      </div>
    </div>
  );
};

export const GridTile: React.FC<{ at: number; logo?: string; badge?: string; c: string; name: string; s?: number; hot?: boolean }> = ({ at, logo, badge, c, name, s = 1, hot }) => {
  const f = useCurrentFrame();
  const g = ez(f, at, at + 10);
  const pulse = 0.28 + 0.72 * Math.abs(Math.sin((f + at * 6) / 19));
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 12 * s, borderRadius: 14 * s,
      border: `1.5px solid ${hot ? c : RULE}`, background: hot ? `${c}1C` : WHITE,
      padding: `${13 * s}px ${15 * s}px`, opacity: g,
      transform: `translateY(${(1 - g) * 14 + br(f, at, 2.4, 30 + (at % 5) * 4)}px) scale(${hot ? 1.02 : 1})`,
      boxShadow: hot ? `0 16px 34px -22px ${c}` : "none",
    }}>
      {logo ? <Logo f={logo} s={28 * s} /> : (
        <span style={{ width: 28 * s, height: 28 * s, borderRadius: 7, background: c, color: INK, display: "grid", placeItems: "center", fontSize: 14 * s, fontWeight: 800, flex: "none" }}>{badge}</span>
      )}
      <span style={{ fontSize: 19 * s, fontWeight: 650, whiteSpace: "nowrap", flex: 1 }}>{name}</span>
      <span style={{ width: 8 * s, height: 8 * s, borderRadius: 99, background: c, opacity: pulse, flex: "none" }} />
    </div>
  );
};

export const Pill: React.FC<{ t: string; c?: string; at?: number; s?: number; solid?: boolean }> = ({ t, c = INK_MUTED, at = 0, s = 1, solid }) => {
  const f = useCurrentFrame();
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 6 * s, borderRadius: 7 * s,
      background: solid ? `${c}26` : `${c}16`, border: `1px solid ${c}66`, color: solid ? INK : INK_SOFT,
      padding: `${4 * s}px ${9 * s}px`, fontSize: 13 * s, fontWeight: 680, whiteSpace: "nowrap",
      opacity: ez(f, at, at + 9), transform: `scale(${0.9 + 0.1 * ez(f, at, at + 9)})`,
    }}>{t}</span>
  );
};

export const Btn: React.FC<{ t: string; kind?: "primary" | "secondary" | "done"; at?: number; s?: number; press?: number }> = ({ t, kind = "secondary", at = 0, s = 1, press }) => {
  const f = useCurrentFrame();
  const g = ez(f, at, at + 9);
  const hit = press !== undefined && f >= press;
  const sq = press !== undefined ? 1 - 0.05 * (ez(f, press, press + 3) - ez(f, press + 3, press + 11)) : 1;
  const style: React.CSSProperties =
    kind === "primary" || hit
      ? { background: INK, color: CREAM, border: `1.5px solid ${INK}` }
      : kind === "done"
        ? { background: "rgba(22,127,80,.15)", color: SUCCESS, border: "1.5px solid rgba(22,127,80,.3)" }
        : { background: CREAM, color: INK_SOFT, border: `1.5px solid ${RULE}` };
  return (
    <span style={{
      ...style, display: "inline-flex", alignItems: "center", gap: 8 * s,
      borderRadius: 10 * s, padding: `${9 * s}px ${16 * s}px`, fontSize: 17 * s, fontWeight: 660,
      opacity: g, transform: `translateY(${(1 - g) * 8}px) scale(${sq})`, whiteSpace: "nowrap",
    }}>{t}</span>
  );
};

export const Cursor: React.FC<{ path: [number, number][]; at: number; per?: number; s?: number; clickAt?: number }> = ({ path, at, per = 22, s = 1, clickAt }) => {
  const f = useCurrentFrame();
  const t = Math.max(0, f - at) / per;
  const i = Math.min(Math.floor(t), path.length - 2);
  const k = ez(f, at + i * per, at + (i + 1) * per);
  const [x0, y0] = path[i] ?? path[0];
  const [x1, y1] = path[i + 1] ?? path[path.length - 1];
  const x = x0 + (x1 - x0) * k, y = y0 + (y1 - y0) * k;
  const ring = clickAt === undefined ? 0 : ez(f, clickAt, clickAt + 14);
  return (
    <div style={{ position: "absolute", left: x, top: y, pointerEvents: "none" }}>
      {clickAt !== undefined && f >= clickAt ? (
        <span style={{
          position: "absolute", left: -46 * s, top: -46 * s, width: 92 * s, height: 92 * s, borderRadius: 99,
          border: `3px solid ${INK}`, opacity: (1 - ring) * 0.8, transform: `scale(${0.3 + ring * 1.1})`,
        }} />
      ) : null}
      <svg width={30 * s} height={38 * s} viewBox="0 0 24 30" style={{ filter: "drop-shadow(0 3px 6px rgba(0,0,0,.35))" }}>
        <path d="M3 2 L3 23 L8.5 18 L12 27 L16 25 L12.5 16.5 L20 16 Z" fill={WHITE} stroke={INK} strokeWidth={1.7} strokeLinejoin="round" />
      </svg>
    </div>
  );
};

export const Ledger: React.FC<{ rows: [string, string][]; at: number; s?: number; c?: string }> = ({ rows, at, s = 1, c = MARIGOLD }) => {
  const f = useCurrentFrame();
  return (
    <div style={{ borderRadius: 14 * s, border: `1.5px solid ${RULE}`, background: CREAM_DEEP, padding: `${16 * s}px ${20 * s}px`, opacity: ez(f, at, at + 9) }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9 * s, marginBottom: 10 * s }}>
        <span style={{ width: 9 * s, height: 9 * s, borderRadius: 99, background: c }} />
        <Mono s={12.5 * s} c={INK_SOFT}>Why it ranks here</Mono>
      </div>
      {rows.map(([k, v], i) => {
        const g = ez(f, at + 4 + i * 2, at + 14 + i * 2);
        return (
          <div key={k} style={{ display: "flex", alignItems: "baseline", gap: 14 * s, padding: `${7 * s}px 0`, borderTop: i ? `1px solid ${RULE}` : "none", opacity: g }}>
            <span style={{ fontSize: 18 * s, color: INK_MUTED, flex: 1 }}>{k}</span>
            <span style={{ fontSize: 19 * s, fontWeight: 720, fontVariantNumeric: "tabular-nums", transform: `translateY(${(1 - g) * 5}px)` }}>{v}</span>
          </div>
        );
      })}
    </div>
  );
};

export const Chip: React.FC<{ t: string; c: string; at: number; s?: number }> = ({ t, c, at, s = 1 }) => {
  const f = useCurrentFrame();
  const g = ez(f, at, at + 11);
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 9 * s, borderRadius: 999,
      border: `1.5px solid ${RULE}`, background: WHITE, padding: `${10 * s}px ${18 * s}px`,
      fontSize: 19 * s, fontWeight: 600, color: INK_SOFT, whiteSpace: "nowrap",
      opacity: g, transform: `translateY(${(1 - g) * 16 + br(f, at, 2, 44)}px)`,
      boxShadow: "0 10px 24px -20px rgba(0,0,0,.4)",
    }}>
      <span style={{ width: 9 * s, height: 9 * s, borderRadius: 99, background: c, flex: "none" }} />
      {t}
    </span>
  );
};

export const Win: React.FC<{ x: number; y: number; w: number; h: number; url: string; tab?: string; children: React.ReactNode }> = ({ x, y, w, h, url, tab = "Growth", children }) => {
  const f = useCurrentFrame();
  const g = fast(f, 0);
  return (
    <div style={{
      position: "absolute", left: x, top: y, width: w, height: h, borderRadius: 18,
      background: CREAM, border: `1px solid ${RULE}`, overflow: "hidden",
      boxShadow: "0 40px 90px -52px rgba(0,0,0,.45)", opacity: g, transform: `translateY(${(1 - g) * 14}px)`,
    }}>
      <div style={{ height: 52, background: CREAM_DEEP, borderBottom: `1px solid ${RULE}`, display: "flex", alignItems: "center", gap: 14, padding: "0 18px" }}>
        <span style={{ display: "flex", gap: 7 }}>
          {[CORAL, MARIGOLD, MINT].map((c) => <span key={c} style={{ width: 11, height: 11, borderRadius: 99, background: c }} />)}
        </span>
        <span style={{ background: WHITE, border: `1px solid ${RULE}`, borderRadius: 8, padding: "5px 14px", fontSize: 14, color: INK_MUTED, fontFamily: MONO }}>{url}</span>
        <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
          <Mono s={11.5}>{tab}</Mono>
          <span style={{ width: 8, height: 8, borderRadius: 99, background: MINT_DEEP, opacity: 0.35 + 0.65 * Math.abs(Math.sin(f / 14)) }} />
        </span>
      </div>
      <div style={{ position: "absolute", inset: "52px 0 0 0" }}>{children}</div>
    </div>
  );
};

export const ActionCard: React.FC<{
  x?: number; y?: number; w?: number; at: number; title: string; channel: string; logo?: string; badge?: string; c: string;
  score?: number; body?: string; s?: number; children?: React.ReactNode; back?: boolean;
}> = ({ x, y, w = 980, at, title, channel, logo, badge, c, score, body, s = 1, children, back }) => {
  const f = useCurrentFrame();
  const g = ez(f, at, at + 12);
  return (
    <div style={{
      position: x === undefined ? "relative" : "absolute", left: x, top: y, width: w,
      borderRadius: 20 * s, background: WHITE, border: `1.5px solid ${back ? RULE : INK}`,
      boxShadow: back ? "0 16px 40px -34px rgba(0,0,0,.4)" : `0 28px 60px -36px rgba(0,0,0,.45)`,
      opacity: g * (back ? 0.62 : 1), transform: `translateY(${(1 - g) * 18}px)`, overflow: "hidden",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 * s, padding: `${16 * s}px ${22 * s}px 0` }}>
        {logo ? <Logo f={logo} s={26 * s} /> : (
          <span style={{ width: 26 * s, height: 26 * s, borderRadius: 7, background: c, color: INK, display: "grid", placeItems: "center", fontSize: 13 * s, fontWeight: 800, flex: "none" }}>{badge}</span>
        )}
        <Mono s={12.5 * s} c={INK_SOFT}>{channel}</Mono>
        <Pill t="New" c={c} at={at + 4} s={s} />
        {score !== undefined ? (
          <span style={{ marginLeft: "auto", background: BONE, borderRadius: 8 * s, padding: `${4 * s}px ${11 * s}px`, fontSize: 15 * s, fontWeight: 660, fontVariantNumeric: "tabular-nums", color: INK_SOFT }}>
            Score {score}
          </span>
        ) : null}
      </div>
      <div style={{ padding: `${10 * s}px ${22 * s}px ${18 * s}px` }}>
        <div style={{ fontSize: 30 * s, fontWeight: 740, letterSpacing: -0.9 * s, lineHeight: 1.16 }}>{title}</div>
        {body ? <div style={{ fontSize: 19 * s, lineHeight: 1.45, color: INK_SOFT, marginTop: 8 * s }}>{body}</div> : null}
        {children}
      </div>
    </div>
  );
};

export const Stamp: React.FC<{ x?: number; y?: number; t?: string; s?: number }> = ({ x = 1470, y = 42, t = "Illustrative company", s = 1 }) => {
  const f = useCurrentFrame();
  return (
    <div style={{
      position: "absolute", left: x, top: y, display: "inline-flex", alignItems: "center", gap: 8 * s,
      border: `1.5px solid ${INK}`, borderRadius: 8 * s, padding: `${5 * s}px ${12 * s}px`,
      background: MARIGOLD, opacity: 0.86 * ez(f, 2, 14), transform: `rotate(-1.4deg)`,
    }}>
      <Mono s={12 * s} c={INK} ls={1.5}>{t}</Mono>
    </div>
  );
};

export const FACTS: [string, string][] = [
  ["Free shipping starts at $75. The best seller is $24.", "northboundcoffee.com"],
  ["1,240 people bought once and never came back.", "shopify.com"],
  ["Three keywords burned $40 a week with zero conversions.", "ads.google.com"],
  ["41 threads in r/coffee ask for a subscription under $30.", "reddit.com"],
  ["Repeat rate is 11 percent, down from 14 in June.", "shopify.com"],
];

export const RANKED: {
  n: number; logo?: string; badge?: string; c: string; name: string; why: string;
}[] = [
  { n: 1, badge: "@", c: MINT, name: "Email", why: "1,240 people already bought once. That is the cheapest order you can get this quarter." },
  { n: 2, logo: "google-ads-icon.svg", c: MARIGOLD, name: "Google Ads", why: "Three keywords burn $40 a week and convert nobody. Cutting them funds everything below." },
  { n: 3, logo: "reddit-channel.svg", c: CORAL, name: "Reddit", why: "This will not move the number this quarter. It grows the pool the other two work on next." },
  { n: 4, logo: "google-icon.svg", c: BRAND.google, name: "SEO", why: "Nothing you rank for today mentions a subscription." },
  { n: 5, logo: "instagram-channel.svg", c: BRAND.instagram, name: "Instagram", why: "Your best photos are on the product pages and nowhere else." },
];

export const REGISTRY: { logo?: string; badge?: string; c: string; name: string }[] = [
  { logo: "google-ads-icon.svg", c: BRAND.gads, name: "Google Ads" },
  { logo: "meta-icon.svg", c: BRAND.meta, name: "Meta Ads" },
  { logo: "reddit-channel.svg", c: BRAND.reddit, name: "Reddit Ads" },
  { logo: "tiktok-channel.svg", c: BRAND.tiktok, name: "TikTok Ads" },
  { logo: "linkedin-channel.svg", c: BRAND.linkedin, name: "LinkedIn Ads" },
  { logo: "youtube-channel.svg", c: BRAND.youtube, name: "YouTube Ads" },
  { logo: "google-icon.svg", c: BRAND.google, name: "SEO" },
  { badge: "G", c: MARIGOLD, name: "GEO" },
  { logo: "reddit-channel.svg", c: BRAND.reddit, name: "Reddit" },
  { logo: "instagram-channel.svg", c: BRAND.instagram, name: "Instagram" },
  { logo: "linkedin-channel.svg", c: BRAND.linkedin, name: "LinkedIn" },
  { logo: "tiktok-channel.svg", c: BRAND.tiktok, name: "TikTok" },
  { badge: "X", c: INK, name: "X" },
  { logo: "youtube-channel.svg", c: BRAND.youtube, name: "YouTube" },
  { badge: "@", c: MINT, name: "Email" },
  { badge: "S", c: MINT, name: "SMS" },
  { badge: "U", c: CORAL, name: "UGC" },
  { badge: "A", c: CORAL, name: "AI UGC" },
  { logo: "github-icon.svg", c: BRAND.github, name: "Dev content" },
];

export const SCORE_INPUTS: [string, string][] = [
  ["Impact the run estimated (1 to 5)", "4"],
  ["Fits your plan and goals", "Yes"],
  ["Where the agent ranked it in its run", "3"],
  ["Actions in that run", "9"],
  ["You rejected a similar action before", "No"],
  ["Blocks the rest of this channel", "No"],
];
