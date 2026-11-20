
import { loadBookableCreator, loadCreatorJob, attachCheckoutSession, type CreatorJobRow } from "./booking-db";
import { resumeCreatorCheckout } from "./orders-money";
import { offerReturnUrls } from "./offer-money-port";
import { applicantHireCancelPath, businessJobReturnPaths } from "./hub-links";
import { getOfferView } from "./offers";
import { ExpectedToolError } from "@/services/tools/types";

function origin(): string {
  return (process.env.WEB_ORIGIN || "https://www.zaviagent.com").split(",")[0].trim().replace(/\/+$/, "");
}

export function resumeReturnUrls(row: Pick<CreatorJobRow, "id" | "source" | "brief_id" | "application_id">): {
  success_url: string;
  cancel_url: string;
} {
  const id = encodeURIComponent(row.id);
  const back = businessJobReturnPaths(id);
  if (row.source === "offer") {
    const u = offerReturnUrls();
    return { success_url: u.success_url.replace("{ORDER_ID}", encodeURIComponent(row.id)), cancel_url: u.cancel_url.replace("{ORDER_ID}", encodeURIComponent(row.id)) };
  }
  if (row.source === "applicant" && row.brief_id && row.application_id) {
    return {
      success_url: `${origin()}${back.success}`,
      cancel_url: `${origin()}${applicantHireCancelPath(row.brief_id, row.application_id, id)}`,
    };
  }
  return { success_url: `${origin()}${back.success}`, cancel_url: `${origin()}${back.cancel}` };
}

export type ResumeDeps = {
  loadJob: typeof loadCreatorJob;
  loadCreator: typeof loadBookableCreator;
  resume: typeof resumeCreatorCheckout;
  attach: typeof attachCheckoutSession;
  offerExpired: (tenant_id: string, offer_id: string) => Promise<boolean>;
};

export const realResumeDeps: ResumeDeps = {
  loadJob: loadCreatorJob,
  loadCreator: loadBookableCreator,
  resume: resumeCreatorCheckout,
  attach: attachCheckoutSession,
  offerExpired: async (tenant_id, offer_id) => {
    const offer = await getOfferView({ tenant_id, offer_id });
    return !offer || offer.expired;
  },
};

export async function resumeOrderCheckout(
  args: { tenant_id: string; order_id: string },
  deps: ResumeDeps = realResumeDeps,
): Promise<{ order_id: string; checkout_url: string | null }> {
  const row = await deps.loadJob(args.tenant_id, args.order_id);
  if (!row) throw new ExpectedToolError("creator_order_not_found", "That job is not in this workspace.");
  if (row.source === "offer" && (!row.offer_id || (await deps.offerExpired(args.tenant_id, row.offer_id)))) {
    throw new ExpectedToolError("offer_expired", "This offer expired unpaid, so nothing was charged. Ask the creator for a new one.");
  }
  const creator = await deps.loadCreator(row.human_member_id);
  const urls = resumeReturnUrls(row);
  const title = (row.package_snapshot as Record<string, unknown> | null)?.title;
  const hold = await deps.resume({
    tenant_id: args.tenant_id,
    order_id: row.id,
    creator_country: creator?.country_code ?? "",
    success_url: urls.success_url,
    cancel_url: urls.cancel_url,
    product_name: typeof title === "string" ? title : undefined,
    ...(row.source === "booking"
      ? {
          alternate_urls: [
            {
              success_url: `${origin()}/humans/jobs/${encodeURIComponent(row.id)}?paid=1`,
              cancel_url: `${origin()}/humans/jobs?cancelled=1`,
            },
          ],
        }
      : {}),
  });
  if (!hold.reused_session) {
    await deps.attach({ tenant_id: args.tenant_id, order_id: row.id, checkout_session_id: hold.checkout_session_id });
  }
  return { order_id: row.id, checkout_url: hold.url };
}
