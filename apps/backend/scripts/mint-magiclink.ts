
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

async function main() {
  const url = process.env.SUPABASE_URL;
  const svc = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const email = process.argv[2] || "ravi@upcar.ai";
  const redirectTo = process.argv[3] || "https://www.zaviagent.com/auth/callback?next=/onboarding";
  if (!url || !svc) {
    console.error("missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }

  const sc = createClient(url, svc, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data, error } = await sc.auth.admin.generateLink({
    type: "magiclink",
    email,
    options: { redirectTo },
  });
  if (error) {
    console.error("generateLink failed:", error);
    process.exit(1);
  }

  console.log("EMAIL:", email);
  console.log("ACTION_LINK:", data.properties?.action_link);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
