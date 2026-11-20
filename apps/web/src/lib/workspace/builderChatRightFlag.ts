
export function isBuilderChatRightEnabled(): boolean {
  return process.env.NEXT_PUBLIC_BUILDER_CHAT_RIGHT !== "false";
}
