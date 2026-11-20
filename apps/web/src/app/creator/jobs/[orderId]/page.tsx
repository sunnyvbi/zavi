
import type { Metadata } from "next";
import { CreatorChrome } from "@/components/creator/CreatorChrome";
import { CreatorJobsScreen } from "@/components/creator/CreatorJobs";

export const metadata: Metadata = {
  title: "Your job",
  robots: { index: false, follow: false },
};

export default async function CreatorJobPage(props: { params: Promise<{ orderId: string }> }) {
  const params = await props.params;
  return (
    <CreatorChrome title="Job">
      <CreatorJobsScreen orderId={params.orderId} />
    </CreatorChrome>
  );
}
