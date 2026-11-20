export const BUILD_REPLAY_SETTING = "build_replay_fixture" as const;
export const BUILD_REPLAY_OFF = "off";
export const BUILD_REPLAY_FIXTURES = ["db-app"] as const;

export function buildReplayAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== "production" && !env.EXECUTION_ENV;
}
