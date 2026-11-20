import { redirect } from "next/navigation";
import type { WorkspaceSearchParams } from "../WorkspacePage";

export default async function Page(
  props: {
    searchParams?: Promise<WorkspaceSearchParams>;
  }
) {
  const searchParams = await props.searchParams;
  const query = new URLSearchParams();
  const params = (searchParams ?? {}) as Record<string, string | string[] | undefined>;
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") query.append(key, value);
    else if (Array.isArray(value)) for (const v of value) query.append(key, v);
  }
  const qs = query.toString();
  redirect(qs ? `/workspace?${qs}` : "/workspace");
}
