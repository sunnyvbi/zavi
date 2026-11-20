export const DEFAULT_NOTETAKER_BOT_NAME = "Zavi Notetaker";

export const DEFAULT_NOTETAKER_CONSENT_MESSAGE =
  "Zavi Notetaker is recording and transcribing this meeting to brief your AI team. Important decisions and blockers are saved; the recording itself is deleted after transcription. A summary is shared with your team after the call. Ask the host to disable Zavi in workspace settings to opt out.";

export const DEFAULT_NOTETAKER_SETTINGS = {
  enabled: true,
  meeting_url: "",
  days_of_week: [1, 2, 3, 4, 5],
  join_time: "09:30",
  timezone: "America/Los_Angeles",
  bot_name: DEFAULT_NOTETAKER_BOT_NAME,
  consent_message: DEFAULT_NOTETAKER_CONSENT_MESSAGE,
  recap_destination: null,
  slack_channel_id: null,
  slack_channel_name: null,
};

export function notetakerEnabledByDefault(
  settings: { enabled?: boolean | null } | null | undefined,
): boolean {
  return settings?.enabled !== false;
}
