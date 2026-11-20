"use client";

import { useEffect, useState } from "react";

export function CampaignScheduleStatus({ endTime }: { endTime: number | null | undefined }) {
  const [ended, setEnded] = useState(false);

  useEffect(() => {
    if (typeof endTime !== "number" || !Number.isFinite(endTime)) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      const remaining = endTime * 1000 - Date.now();
      setEnded(remaining <= 0);
      if (remaining > 0) timer = setTimeout(update, Math.min(remaining, 2_147_483_647));
    };
    update();
    return () => clearTimeout(timer);
  }, [endTime]);

  return ended ? <p className="mt-1 text-xs text-inkMuted">Schedule ended</p> : null;
}
