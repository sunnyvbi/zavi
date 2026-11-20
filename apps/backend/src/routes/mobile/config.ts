
import type { Request, Response } from "express";

import { getBoolSetting } from "@/services/settings";

const FAIL_OPEN = { isSignupEnabled: true, isIosBillingEnabled: true, isIosAppStoreLive: false } as const;

export async function getMobileConfig(_req: Request, res: Response): Promise<void> {
  res.set("Cache-Control", "no-store");

  try {
    const [isSignupEnabled, isIosBillingEnabled, isIosAppStoreLive] = await Promise.all([
      getBoolSetting("mobile_signup_enabled"),
      getBoolSetting("mobile_ios_billing_enabled"),
      getBoolSetting("ios_app_store_live"),
    ]);
    res.status(200).json({ isSignupEnabled, isIosBillingEnabled, isIosAppStoreLive });
  } catch {
    res.status(200).json(FAIL_OPEN);
  }
}
