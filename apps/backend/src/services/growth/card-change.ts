
import { gadsChangeRows } from "@/services/tools/google-ads/write/_change-rows";
import { metaChangeRows } from "@/services/tools/meta-ads/write/_change-rows";
import { stripInternalIds } from "./cgo-note-items";

const FULLY_STATED = new Set([
  "google_ads.update_campaign_budget",
  "meta_ads.update_ad_set_budget",
  "google_ads.set_status",
  "meta_ads.set_status",
]);

export function cardChangeSentence(exec_class: string | null | undefined, exec_payload: unknown): string | null {
  if (!exec_class || !FULLY_STATED.has(exec_class.replace(/_review$/, ""))) return null;
  let sentence: string | undefined;
  try {
    if (exec_class.startsWith("google_ads.")) sentence = gadsChangeRows(exec_class, exec_payload)?.change_sentence;
    else if (exec_class.startsWith("meta_ads.")) sentence = metaChangeRows(exec_class, exec_payload)?.change_sentence;
  } catch {
    return null;
  }
  const s = typeof sentence === "string" ? stripInternalIds(sentence.replace(/\s+/g, " ")).trim() : "";
  return s.length >= 10 && s.length <= 600 ? s : null;
}
