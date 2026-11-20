
import { VideoSparkle } from "../../icons/videoSparkle";
import type { PlatformSpec } from "./_shared";

export const generated_video: PlatformSpec = {
  name: "AI UGC Videos",
  topActions: [],
  icon: VideoSparkle,

  starters: true,
  studio: true,
  postsNoun: "Videos",
  maxWidth: "max-w-[1120px]",

  execCopy: {
    working: "Making your video. This takes a few minutes.",
    done: "Your video is ready. You were charged only now that it arrived.",
    failedTitle: "The video could not be made.",
    failedHint: "You were not charged. Press Try again to make it again.",
  },
};
