
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function StartersRedirect(
  props: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
  }
) {
  const searchParams = await props.searchParams;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(searchParams)) {
    for (const one of Array.isArray(v) ? v : v === undefined ? [] : [v]) qs.append(k, one);
  }
  const q = qs.toString();
  redirect(q ? `/tools?${q}` : "/tools");
}
