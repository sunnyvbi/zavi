"use client";

import { useUgcDrawer } from "./hub";
import { BTN_SECONDARY, CARD } from "./ui";

export function WriteBriefBlock() {
  const drawer = useUgcDrawer();
  return (
    <section aria-labelledby="ugc-write-brief-title" className={`${CARD} flex flex-wrap items-center justify-between gap-3`}>
      <div className="min-w-0 flex-1">
        <h3 id="ugc-write-brief-title" className="text-[15px] font-semibold text-ink">
          Write your own brief
        </h3>
        <p className="mt-1 text-[13px] leading-[18px] text-inkMuted">
          Start a blank brief by hand. When you run UGC Videos, Zavi drafts one for you instead.
        </p>
      </div>
      <button type="button" onClick={() => drawer.open("brief")} className={BTN_SECONDARY}>
        Write your own brief
      </button>
    </section>
  );
}
