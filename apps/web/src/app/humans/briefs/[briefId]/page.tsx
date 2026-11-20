
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function HumanBriefIndexPage(
  props: {
    params: Promise<{ briefId: string }>;
  }
) {
  const params = await props.params;
  redirect(`/humans/briefs/${encodeURIComponent(params.briefId)}/matches`);
}
