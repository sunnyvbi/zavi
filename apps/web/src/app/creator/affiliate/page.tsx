
import type { Metadata } from "next";
import { CreatorChrome } from "@/components/creator/CreatorChrome";
import { CreatorAffiliateScreen } from "@/components/creator/CreatorAffiliate";

export const metadata: Metadata = {
  title: "Your affiliate link",
  robots: { index: false, follow: false },
};

export default function CreatorAffiliatePage() {
  return (
    <CreatorChrome title="Affiliate">
      <CreatorAffiliateScreen />
    </CreatorChrome>
  );
}
