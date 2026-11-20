"use client";

import type { ReactNode } from "react";
import { createPortal } from "react-dom";

export function EditorLayer({ children }: { children: ReactNode }) {
  return createPortal(children, document.querySelector(".workspace-shell") ?? document.body);
}
