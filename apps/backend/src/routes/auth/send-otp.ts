
import { createHash } from "node:crypto";
import { verifySignupLocationTicket } from "@/services/account/signup-location-ticket";
import { signupLocationClient } from "@/services/tenant-client";
import type { Request, Response } from "express";
import { sendOtpEmail } from "@/email/sendAuthEmail";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function authEmailSendOtp(
  req: Request,
  res: Response,
): Promise<void> {
  const email =
    typeof req.body?.email === "string"
      ? req.body.email.trim().toLowerCase()
      : "";
  if (!email || !EMAIL_RE.test(email)) {
    res.status(400).json({
      error: {
        code: "invalid_email",
        message: "A valid email address is required.",
      },
    });
    return;
  }

  try {
    const ticket = req.body?.location_ticket;
    const location =
      typeof ticket?.payload === "string" &&
      typeof ticket?.signature === "string"
        ? verifySignupLocationTicket(
            ticket.payload,
            ticket.signature,
            process.env.SIGNUP_LOCATION_SIGNING_SECRET ?? "",
          )
        : null;
    if (
      location &&
      location.email_hash === createHash("sha256").update(email).digest("hex")
    ) {
      await sendOtpEmail(email, async (userId) => {
        const result = await signupLocationClient(
          "signup-location: signed request bound to the auth user just created for OTP",
        ).rpc("record_admin_growth_signup_location", {
          p_user_id: userId,
          p_country: location.country,
          p_city: location.city,
          p_issued_at: location.issued_at,
        });
        if (result.error) throw new Error("Signup location unavailable");
      });
    } else await sendOtpEmail(email);
    res.status(200).json({ ok: true });
  } catch (e) {
    const msg = (e as Error).message;
    // eslint-disable-next-line no-console
    console.error("[auth/email/send-otp] failed", { msg });
    res.status(500).json({
      error: {
        code: "send_failed",
        message: "Could not send code. Try again in a moment.",
      },
    });
  }
}
