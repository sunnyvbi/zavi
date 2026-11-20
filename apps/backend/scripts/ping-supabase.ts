
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

async function main() {
  const url = process.env.SUPABASE_URL;
  const svc = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anon = process.env.SUPABASE_ANON_KEY;
  if (!url || !svc || !anon) {
    console.error("missing env: SUPABASE_URL/SERVICE_ROLE_KEY/ANON_KEY");
    process.exit(1);
  }
  console.log("URL:", url);
  console.log("svc:", svc.slice(0, 30) + "...");
  console.log("anon:", anon.slice(0, 30) + "...");

  const sc = createClient(url, svc, { auth: { autoRefreshToken: false, persistSession: false } });
  const r1 = await sc.from("tenants").select("id").limit(1);
  if (r1.error) {
    console.log("svc tenants.select →", r1.error.code ?? "?", r1.error.message);
  } else {
    console.log("svc tenants.select OK rows=" + (r1.data?.length ?? 0));
  }

  const ac = createClient(url, anon, { auth: { autoRefreshToken: false, persistSession: false } });
  const r2 = await ac.from("tenants").select("id").limit(1);
  if (r2.error) {
    console.log("anon tenants.select →", r2.error.code ?? "?", r2.error.message);
  } else {
    console.log("anon tenants.select OK rows=" + (r2.data?.length ?? 0));
  }
}
main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
