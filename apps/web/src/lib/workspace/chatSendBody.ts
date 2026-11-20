
export type ChatSendExtras = {
  command_slug?: string;
  image_paths?: string[];
  doc_paths?: string[];
  video_paths?: string[];
  depth?: "deep";
  message_origin?: "app_action";
  preview_session_id?: string;
  edit_of_message_id?: string;
  channels?: string[];
  build_session_id?: string;
  channel_action_id?: string;
  page_channel?: string;
  page_channel_action_id?: string;
  repo_hint?: string;
  model?: string;
};

export function buildChatSendBody(
  message: string,
  threadId: string | null | undefined,
  extras?: ChatSendExtras,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    message,
    thread_id: threadId ?? null,
  };
  if (extras?.command_slug) {
    body.command_slug = extras.command_slug;
  }
  if (extras?.image_paths && extras.image_paths.length > 0) {
    body.image_paths = extras.image_paths;
  }
  if (extras?.doc_paths && extras.doc_paths.length > 0) {
    body.doc_paths = extras.doc_paths;
  }
  if (extras?.video_paths && extras.video_paths.length > 0) {
    body.video_paths = extras.video_paths;
  }
  if (extras?.depth) {
    body.depth = extras.depth;
  }
  if (extras?.message_origin) {
    body.message_origin = extras.message_origin;
  }
  if (extras?.preview_session_id) {
    body.preview_session_id = extras.preview_session_id;
  }
  if (extras?.edit_of_message_id) {
    body.edit_of_message_id = extras.edit_of_message_id;
  }
  if (extras?.channels && extras.channels.length > 0) {
    body.channels = extras.channels;
  }
  if (extras?.build_session_id) {
    body.build_session_id = extras.build_session_id;
  }
  if (extras?.channel_action_id) {
    body.channel_action_id = extras.channel_action_id;
  }
  if (extras?.page_channel) {
    body.page_channel = extras.page_channel;
    if (extras.page_channel_action_id) {
      body.page_channel_action_id = extras.page_channel_action_id;
    }
  }
  if (extras?.repo_hint) {
    body.repo_hint = extras.repo_hint;
  }
  if (extras?.model) {
    body.model = extras.model;
  }
  return body;
}

export function pageOriginExtras(
  pageChannel: string | null | undefined,
  channelActionId: string | null | undefined,
): Pick<ChatSendExtras, "page_channel" | "page_channel_action_id"> {
  if (!pageChannel) return {};
  return {
    page_channel: pageChannel,
    ...(channelActionId ? { page_channel_action_id: channelActionId } : {}),
  };
}
