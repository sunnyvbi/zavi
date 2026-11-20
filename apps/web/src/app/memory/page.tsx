import { redirect } from "next/navigation";
import { MEMORY_URL } from "@/lib/workspace/tabUrl";

export default async function MemoryPage(
  props: {
    searchParams?: Promise<Record<string, string | string[] | undefined>>;
  }
) {
  const searchParams = await props.searchParams;
  const h = searchParams?.h;
  redirect(typeof h === "string" && h ? `${MEMORY_URL}&h=${encodeURIComponent(h)}` : MEMORY_URL);
}
