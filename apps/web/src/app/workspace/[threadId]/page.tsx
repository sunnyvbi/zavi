import { redirect } from "next/navigation";
import { WORKSPACE_UUID_RE } from "@/components/workspace/deepLinkSeed";
import { WorkspacePage, type WorkspaceSearchParams } from "../WorkspacePage";

export const dynamic = "force-dynamic";

export default async function Page(
  props: {
    params: Promise<{ threadId: string }>;
    searchParams?: Promise<WorkspaceSearchParams>;
  }
) {
  const searchParams = await props.searchParams;
  const params = await props.params;
  if (!WORKSPACE_UUID_RE.test(params.threadId)) redirect("/workspace");
  return (
    <WorkspacePage searchParams={searchParams} threadId={params.threadId} />
  );
}
