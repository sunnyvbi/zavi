
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default function StripeReturnPage() {
  redirect("/workspace/settings/payments?kyc=return");
}
