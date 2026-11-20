"use client";

import { useEffect, useState } from "react";
import { ZaviMascot } from "@/components/ZaviMascot";

const SIZES = [
  { px: 220, note: "hero" },
  { px: 120, note: "welcome / 404" },
  { px: 72, note: "analysing" },
  { px: 28, note: "avatar (still)" },
];

export default function MascotPreviewPage() {
  const [dark, setDark] = useState(false);
  const [working, setWorking] = useState(false);
  const [celebrate, setCelebrate] = useState(0);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    return () => document.documentElement.classList.remove("dark");
  }, [dark]);

  const surface = dark ? "bg-[#141414] text-[#ececec]" : "bg-[#F7F6F3] text-ink";
  const button = "rounded-cta border border-current/20 px-3 py-1.5 text-sm";

  return (
    <main className={`min-h-screen px-6 py-12 ${surface}`}>
      <div className="mx-auto max-w-3xl space-y-10">
        <header className="space-y-3">
          <h1 className="text-2xl font-semibold">Zavi mascot preview</h1>
          <p className="text-sm opacity-70">
            Hover or tap a mascot to poke it. Under 48px it is a still, and under{" "}
            <code>prefers-reduced-motion</code> every size is.
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={button} onClick={() => setDark((d) => !d)}>
              {dark ? "Light mode" : "Dark mode"}
            </button>
            <button type="button" className={button} onClick={() => setWorking((w) => !w)}>
              {working ? "Show idle" : "Show working"}
            </button>
            <button type="button" className={button} onClick={() => setCelebrate((n) => n + 1)}>
              Celebrate
            </button>
          </div>
        </header>

        <div className="flex flex-wrap items-end gap-10">
          {SIZES.map(({ px, note }) => (
            <figure key={px} className="flex flex-col items-center gap-2">
              <ZaviMascot size={px} working={working} celebrate={celebrate} />
              <figcaption className="text-xs opacity-60">
                {px}px · {note}
              </figcaption>
            </figure>
          ))}
        </div>

        {dark ? null : (
          <div className="flex items-center gap-6 rounded-2xl bg-white p-8">
            <ZaviMascot size={120} working={working} celebrate={celebrate} />
            <div>
              <p className="text-xl font-semibold">AI Growth Agent For Your Business</p>
              <p className="text-sm text-gray-600">On a white card, the workspace background.</p>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
