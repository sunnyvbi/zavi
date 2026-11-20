
import { apiFetch } from "@/lib/api";
import { normalizeSummary } from "./summary";
import type { HomeSummaryPayload } from "./types";

export type LoadResult =
  | { status: "ok"; summary: HomeSummaryPayload }
  | { status: "no_tenant" }
  | { status: "error" };

export async function loadSummary(): Promise<LoadResult> {
  const res = await apiFetch("/api/home/summary");
  if (res.status === 409) return { status: "no_tenant" };
  if (!res.ok) return { status: "error" };
  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    return { status: "error" };
  }
  return { status: "ok", summary: normalizeSummary(raw) };
}
