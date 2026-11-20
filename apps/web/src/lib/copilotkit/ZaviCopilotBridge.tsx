"use client";

import { copilotTransportEnabled } from "./ZaviCopilotProvider";
import { useZaviUiTools } from "./useZaviUiTools";
import { useZaviScreenContext } from "./useZaviScreenContext";

function Hooks() {
  useZaviUiTools();
  useZaviScreenContext();
  return null;
}

export function ZaviCopilotBridge() {
  if (!copilotTransportEnabled()) return null;
  return <Hooks />;
}
