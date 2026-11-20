
import type { Metadata } from "next";
import { CreatorChrome } from "@/components/creator/CreatorChrome";
import { CreatorEarningsScreen } from "@/components/creator/CreatorEarnings";

export const metadata: Metadata = {
  title: "Your earnings",
  robots: { index: false, follow: false },
};

export default function CreatorEarningsPage() {
  return (
    <CreatorChrome title="Earnings">
      <CreatorEarningsScreen />
    </CreatorChrome>
  );
}
