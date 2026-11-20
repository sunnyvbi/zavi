import { fixture } from "@/lib/tenants-growth-fixture";
const data = structuredClone(fixture);
data.today = new Date(Date.now() + 19800000).toISOString().slice(0, 10);
let failNextRead = false;
window.addEventListener("growth-fixture-fail-next", () => {
  failNextRead = true;
});
export async function adminApiFetch(path: string, opts: RequestInit = {}) {
  await new Promise((r) => setTimeout(r, 30));
  if (path.endsWith("/classify")) {
    const body = JSON.parse(opts.body as string);
    for (const id of body.ids) {
      const record = (
        body.subject_type === "tenant" ? data.tenants : data.users
      ).find((x) => x.id === id);
      if (record) {
        record.is_test = body.is_test;
        record.test_reasons = [];
      }
    }
    return Response.json({ updated: body.ids.length });
  }
  if (failNextRead) {
    failNextRead = false;
    return Response.json(
      { error: { message: "Synthetic read unavailable" } },
      { status: 503 },
    );
  }
  return Response.json({
    ...data,
    usage: path.includes("include_usage=1")
      ? data.tenants.map((t) => ({
          tenant_id: t.id,
          runs: 6,
          user_messages: 2,
          cost_usd: 1.25,
          ok_rate: 0.5,
        }))
      : null,
  });
}
