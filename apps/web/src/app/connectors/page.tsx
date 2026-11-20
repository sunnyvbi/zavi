
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function ConnectorsPage(
  props: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
  }
) {
  const searchParams = await props.searchParams;
  const qs = new URLSearchParams();
  qs.set("tab", "settings");
  for (const [k, v] of Object.entries(searchParams)) {
    if (typeof v === "string") qs.set(k, v);
  }
  redirect(`/workspace?${qs.toString()}`);
}
