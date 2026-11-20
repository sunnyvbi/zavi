
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default function MembersPage() {
  redirect("/workspace?tab=settings#team");
}
