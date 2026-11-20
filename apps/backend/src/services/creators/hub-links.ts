
import { CREATOR_MARKETPLACE_ENABLED } from "@zavi/shared";

export const UGC_HUB_PATH = "/workspace?tab=channels&channel=ugc";

export function businessJobPath(orderToken: string): string {
  return CREATOR_MARKETPLACE_ENABLED ? `${UGC_HUB_PATH}&drawer=job&job=${orderToken}` : `/humans/jobs/${orderToken}`;
}

export function businessJobLink(order_id: string): string {
  return businessJobPath(encodeURIComponent(order_id));
}

export function businessJobReturnPaths(orderToken: string): { success: string; cancel: string } {
  const job = businessJobPath(orderToken);
  const sep = job.includes("?") ? "&" : "?";
  return { success: `${job}${sep}paid=1`, cancel: `${job}${sep}cancelled=1` };
}

export function applicantHireCancelPath(brief_id: string, application_id: string, orderToken: string): string {
  return CREATOR_MARKETPLACE_ENABLED
    ? `${businessApplicantsLink(brief_id)}&application=${encodeURIComponent(application_id)}&hire_cancelled=1`
    : businessJobReturnPaths(orderToken).cancel;
}

export function businessThreadLink(human_member_id: string): string {
  return `${UGC_HUB_PATH}&drawer=thread&creator=${encodeURIComponent(human_member_id)}`;
}

export function businessApplicantsLink(brief_id: string): string {
  return `${UGC_HUB_PATH}&drawer=applicants&brief=${encodeURIComponent(brief_id)}`;
}
