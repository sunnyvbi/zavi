
import type { Metadata } from "next";
import { CreatorChrome } from "@/components/creator/CreatorChrome";
import { CreatorProfileScreen } from "@/components/creator/CreatorProfile";

export const metadata: Metadata = {
  title: "Your profile",
  robots: { index: false, follow: false },
};

export default function CreatorProfilePage() {
  return (
    <CreatorChrome title="Profile">
      <CreatorProfileScreen />
    </CreatorChrome>
  );
}
