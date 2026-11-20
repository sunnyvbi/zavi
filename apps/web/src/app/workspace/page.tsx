import { WorkspacePage, type WorkspaceSearchParams } from "./WorkspacePage";

export const dynamic = "force-dynamic";

export default async function Page(
  props: {
    searchParams?: Promise<WorkspaceSearchParams>;
  }
) {
  const searchParams = await props.searchParams;
  return <WorkspacePage searchParams={searchParams} />;
}
