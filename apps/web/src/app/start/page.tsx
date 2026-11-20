"use client";
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { IdeaStartFlow } from "./IdeaStartFlow";
import { WebsiteStartFlow } from "./WebsiteStartFlow";
export {
  PENDING_BUILD_KEY,
  RESUME_BUILD_PARAM,
  BUILD_SIGNUP_NEXT,
  mayAutoResume,
} from "./ideaStartStorage";
function StartFlow() {
  const search = useSearchParams();
  return search.get("step") === "idea" || search.get("resume") === "build" ? (
    <IdeaStartFlow />
  ) : (
    <WebsiteStartFlow />
  );
}
export default function StartPage() {
  return (
    <Suspense fallback={null}>
      <StartFlow />
    </Suspense>
  );
}
