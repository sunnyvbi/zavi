import type { ChannelMetric } from "@/lib/workspace/channelActionsApi";
import type { PlatformSpec } from "./types";

export function emptyTiles(platform: PlatformSpec): ChannelMetric[] {
  return Object.keys(platform.metricDisplay ?? {}).map((key) => ({
    key,
    value: Number.NaN,
    unit: null,
    window_kind: null,
    day: "",
    grounded: true,
    prev_value: null,
    prev_day: null,
    unmeasured: true,
  }));
}
