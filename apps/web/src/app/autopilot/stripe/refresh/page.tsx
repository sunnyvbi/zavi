
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default function StripeRefreshPage() {
  redirect("/workspace/settings/payments?kyc=refresh");
}
