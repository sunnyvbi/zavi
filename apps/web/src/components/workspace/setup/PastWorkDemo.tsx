"use client";

import { PastWorkDemoBrowser } from "./PastWorkDemoBrowser";
import { PastWorkDemoWindow } from "./PastWorkDemoWindow";
import { usePastWorkDemo } from "./usePastWorkDemo";

export function PastWorkDemo() {
  const phase = usePastWorkDemo();

  return (
    <figure
      aria-hidden="true"
      className="relative mx-auto h-onboarding-demo-stage w-full max-w-onboarding-demo animate-past-work-enter motion-reduce:animate-none"
    >
      <PastWorkDemoBrowser phase={phase} />
      {phase !== "generating" && phase !== "generated" && phase !== "downloaded" && (
        <PastWorkDemoWindow phase={phase} />
      )}
      <figcaption className="sr-only">
        Example: copy the prompt into Claude, download the generated file,
        then upload it to Zavi and press Add to Zavi.
      </figcaption>
    </figure>
  );
}
