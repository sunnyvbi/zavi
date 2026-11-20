import { describe, it, expect, afterEach } from "vitest";
import { createClient } from "@supabase/supabase-js";

const isIntegration = process.env.INTEGRATION === "1";
const sb = isIntegration
  ? createClient(
      process.env.SUPABASE_URL || "http://127.0.0.1:54321",
      process.env.SUPABASE_SERVICE_ROLE_KEY || "service-role-key-from-supabase-status",
    )
  : null;

const created: string[] = [];

async function makeTenant(displayName: string | null, slug: string): Promise<string> {
  const { data, error } = await sb!
    .from("tenants")
    .insert({ slug, display_name: displayName, kind: "test" })
    .select("id")
    .single();
  expect(error, `tenant insert failed: ${error?.message}`).toBeNull();
  const id = (data as { id: string }).id;
  created.push(id);
  return id;
}

async function addressOf(tenantId: string): Promise<string | null> {
  const { data } = await sb!
    .from("tenant_agent_email_identity")
    .select("reply_to_address")
    .eq("tenant_id", tenantId)
    .eq("status", "active")
    .maybeSingle();
  return (data as { reply_to_address?: string } | null)?.reply_to_address ?? null;
}

describe.skipIf(!isIntegration)("every tenant gets an inbox address (integration)", () => {
  afterEach(async () => {
    if (!created.length) return;
    const { error } = await sb!.from("tenants").delete().in("id", created.splice(0));
    expect(error, `tenant cleanup failed: ${error?.message}`).toBeNull();
  });

  it("does not mint for a launch_video_shell, and mints when one is claimed", async () => {
    const slug = `shell-acme-${Date.now()}`;
    const { data, error } = await sb!
      .from("tenants")
      .insert({ slug, display_name: "Shell Acme", kind: "launch_video_shell" })
      .select("id")
      .single();
    expect(error, `shell insert failed: ${error?.message}`).toBeNull();
    const id = (data as { id: string }).id;
    created.push(id);

    expect(await addressOf(id)).toBeNull();
    const { count } = await sb!
      .from("inbox_handle_ledger")
      .select("handle", { count: "exact", head: true })
      .eq("handle", "shell-acme");
    expect(count ?? 0).toBe(0);

    const { error: upErr } = await sb!.from("tenants").update({ kind: "test" }).eq("id", id);
    expect(upErr, `promote failed: ${upErr?.message}`).toBeNull();
    expect(await addressOf(id)).toMatch(/^shell-acme\d*@inbox\.zaviagent\.com$/);
  });

  it("mints for a tenant created without going through either onboarding route", async () => {
    const id = await makeTenant("Mint Raw Door", `mint-raw-${Date.now()}`);
    expect(await addressOf(id)).toMatch(/^mint-raw-door\d*@inbox\.zaviagent\.com$/);
  });

  it("creates the tenant anyway when the desired handle cannot be used", async () => {
    const id = await makeTenant("株式会社", `mint-nonlatin-${Date.now()}`);
    const address = await addressOf(id);
    expect(address, "a name that sanitizes to nothing must still get a fallback address").toMatch(
      /^zv[0-9a-f]{8}@inbox\.zaviagent\.com$/,
    );
  });

  it("gives two same-named tenants two different addresses", async () => {
    const stamp = Date.now();
    const a = await makeTenant("Collision Co", `mint-col-a-${stamp}`);
    const b = await makeTenant("Collision Co", `mint-col-b-${stamp}`);
    const [addrA, addrB] = [await addressOf(a), await addressOf(b)];
    expect(addrA).toBeTruthy();
    expect(addrB).toBeTruthy();
    expect(addrA).not.toBe(addrB);
  });

  it("never mints a handle a reserved address would collide with", async () => {
    const id = await makeTenant("admin", `mint-reserved-${Date.now()}`);
    const address = await addressOf(id);
    expect(address).toBeTruthy();
    expect(address).not.toBe("admin@inbox.zaviagent.com");
  });
});
