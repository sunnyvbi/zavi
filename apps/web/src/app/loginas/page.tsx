
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createServerSupabase } from "@/lib/supabase";
import { EmailLoginAs } from "./EmailLoginAs";

export const dynamic = "force-dynamic";

export default async function LoginAsPage() {
  const supabase = createServerSupabase(await cookies());
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) {
    redirect("/login?next=" + encodeURIComponent("/loginas"));
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <div className="mx-auto max-w-2xl px-6 py-10">
        <div className="mb-1 flex items-center gap-2 text-[12px] font-medium text-slate-500">
          <span className="text-slate-900">Zavi</span>
          <span className="text-slate-300">/</span>
          <span>Staff</span>
        </div>
        <div className="mb-4 flex items-baseline justify-between">
          <h1 className="text-[20px] font-semibold text-slate-900">Login as customer</h1>
          <p className="text-[12px] font-mono text-slate-500">{userData.user.email}</p>
        </div>

        <div className="mb-5 rounded-lg border border-amber-200 bg-amber-50 p-3 text-[12px] text-amber-800">
          <span className="font-semibold">Heads up.</span> This mints a real
          customer session and you act as that user with full write access. Every action is attributed to the customer, not to you. It is audited
          (staff&nbsp;→ target&nbsp;→ tenant). There is no in-place exit: to
          return to staff, sign out and sign back in as yourself.
        </div>

        <EmailLoginAs />
      </div>
    </div>
  );
}
