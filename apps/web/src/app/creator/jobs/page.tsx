
import type { Metadata } from "next";
import { CreatorChrome } from "@/components/creator/CreatorChrome";
import { CreatorJobsScreen } from "@/components/creator/CreatorJobs";

export const metadata: Metadata = {
  title: "Your jobs",
  robots: { index: false, follow: false },
};

export default function CreatorJobsPage() {
  return (
    <CreatorChrome title="Jobs">
      <CreatorJobsScreen />
    </CreatorChrome>
  );
}
