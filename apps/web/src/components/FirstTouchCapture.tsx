"use client";

import { useEffect } from "react";
import { captureFirstTouch } from "@/lib/analytics/first-touch";
import { captureAffiliateClick } from "@/lib/analytics/affiliate";

export function FirstTouchCapture() {
  useEffect(() => {
    captureFirstTouch();
    void captureAffiliateClick();
  }, []);
  return null;
}
