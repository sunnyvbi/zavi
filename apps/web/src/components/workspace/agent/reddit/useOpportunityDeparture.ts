import { useEffect, useRef, useState } from "react";

export function useOpportunityDeparture(onChanged?: () => void | Promise<void>) {
  const [postedLocal, setPostedLocal] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [gone, setGone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  const leaveAsPosted = () => {
    if (timer.current) return;
    setPostedLocal(true);
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    timer.current = setTimeout(() => {
      setLeaving(true);
      timer.current = setTimeout(() => {
        timer.current = null;
        setGone(true);
        void onChanged?.();
      }, still ? 0 : 450);
    }, still ? 600 : 1100);
  };
  return { postedLocal, leaving, gone, leaveAsPosted };
}
