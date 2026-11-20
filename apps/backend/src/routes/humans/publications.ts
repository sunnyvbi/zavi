
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { loadCreatorJob } from "@/services/creators/booking-db";
import {
  PUBLISH_PLATFORMS,
  insertPublication,
  listPublications,
  loadPublication,
  postUrlFor,
  publisherFor,
  updateVerification,
  verifyPost,
} from "@/services/creators/publications";

const Uuid = z.string().uuid();

const Body = z.object({
  platform: z.enum(PUBLISH_PLATFORMS),
  account: z.string().trim().max(200).optional(),
  post_url: z.string().trim().max(2000).optional(),
  published_at: z.string().datetime().optional(),
  scheduled_for: z.string().datetime().optional(),
});

function fail(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

export async function getOrderPublications(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const id = Uuid.safeParse(req.params.orderId);
  if (!id.success) return fail(res, 400, "bad_order_id", "That is not an order id.");
  try {
    const order = await loadCreatorJob(auth.tenant_id, id.data);
    if (!order) return fail(res, 404, "creator_order_not_found", "That job is not in this workspace.");
    res.json({
      publisher: publisherFor(order.package_snapshot as Record<string, unknown> | null),
      can_record: order.status === "completed",
      publications: await listPublications(auth.tenant_id, order.id),
    });
  } catch (e) {
    console.error(`[humans/publications] list failed: ${(e as Error).message}`);
    fail(res, 500, "publications_read_failed", "Could not load where this video was posted.");
  }
}

export async function postOrderPublication(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const id = Uuid.safeParse(req.params.orderId);
  if (!id.success) return fail(res, 400, "bad_order_id", "That is not an order id.");
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "validation", "Pick a platform, then add the post link or the planned time.");
  const b = parsed.data;
  try {
    const order = await loadCreatorJob(auth.tenant_id, id.data);
    if (!order) return fail(res, 404, "creator_order_not_found", "That job is not in this workspace.");
    if (order.status !== "completed") {
      return fail(res, 409, "not_approved", "Approve the video first. Posts can be recorded once the job is approved.");
    }
    const publisher = publisherFor(order.package_snapshot as Record<string, unknown> | null);
    const account = b.account ? b.account : null;
    if (b.post_url) {
      const url = postUrlFor(b.platform, b.post_url);
      if (!url) return fail(res, 400, "bad_post_url", `That is not a ${b.platform} post link. Paste the https link to the post.`);
      const check = await verifyPost(b.platform, url, account);
      const row = await insertPublication(auth.tenant_id, {
        order_id: order.id,
        publisher,
        platform: b.platform,
        account,
        post_url: url,
        status: "published",
        scheduled_for: null,
        published_at: b.published_at ?? new Date().toISOString(),
        verification: check.verification,
        verification_note: check.note,
        verified_at: check.verification === "verified" ? new Date().toISOString() : null,
        created_by: auth.user_id,
      });
      res.json({ publication: row });
      return;
    }
    if (!b.scheduled_for) return fail(res, 400, "validation", "Add the post link, or the time you plan to post it.");
    const row = await insertPublication(auth.tenant_id, {
      order_id: order.id,
      publisher,
      platform: b.platform,
      account,
      post_url: null,
      status: "scheduled",
      scheduled_for: b.scheduled_for,
      published_at: null,
      verification: "pending",
      verification_note: "Planned. Once it is live, add it again with its link and Zavi checks it.",
      verified_at: null,
      created_by: auth.user_id,
    });
    res.json({ publication: row });
  } catch (e) {
    console.error(`[humans/publications] record failed: ${(e as Error).message}`);
    fail(res, 500, "publication_write_failed", "Could not save that post. Try again.");
  }
}

export async function postPublicationVerify(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const id = Uuid.safeParse(req.params.id);
  if (!id.success) return fail(res, 400, "bad_id", "That is not a post id.");
  try {
    const row = await loadPublication(auth.tenant_id, id.data);
    if (!row) return fail(res, 404, "not_found", "That post is not in this workspace.");
    if (!row.post_url) return fail(res, 409, "no_link", "Add the post link first.");
    const check = await verifyPost(row.platform, row.post_url, row.account);
    res.json({ publication: await updateVerification(auth.tenant_id, row.id, check) });
  } catch (e) {
    console.error(`[humans/publications] verify failed: ${(e as Error).message}`);
    fail(res, 500, "verify_failed", "Could not check that post. Try again.");
  }
}
