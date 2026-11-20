
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createServerSupabase } from "@/lib/supabase";
import { ExtensionConnectPanel } from "./ExtensionConnectPanel";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Connect the Zavi extension",
  robots: { index: false, follow: false },
};

export default async function ExtensionConnectPage() {
  const supabase = createServerSupabase(await cookies());
  const { data } = await supabase.auth.getUser();
  const email = data.user?.email ?? null;

  if (!email) {
    redirect(`/login?next=${encodeURIComponent("/extension/connect")}`);
  }

  return <ExtensionConnectPanel email={email} />;
}
