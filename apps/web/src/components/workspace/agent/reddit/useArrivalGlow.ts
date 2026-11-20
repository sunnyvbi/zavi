import { useEffect, useRef, useState } from "react";
import { scrollToInPanel } from "./ui";

export function useArrivalGlow(arrival: number) {
  const [on, setOn] = useState(false);
  const target = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!arrival) return;
    setOn(true);
    const el = target.current;
    if (el && !scrollToInPanel(el, "start") && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "start" });
    }
    const id = setTimeout(() => setOn(false), 2600);
    return () => clearTimeout(id);
  }, [arrival]);
  return { on, target };
}

