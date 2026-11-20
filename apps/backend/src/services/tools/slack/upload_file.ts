
import { slackFetch } from "./_client";

type GetUploadUrlResp = { upload_url?: string; file_id?: string };

export async function uploadFileToThread(args: {
  tenant_id: string;
  channel_id: string;
  thread_ts?: string;
  bytes: Uint8Array;
  filename: string;
  title?: string;
  team_id?: string;
}): Promise<{ file_id: string }> {
  const reserve = await slackFetch<GetUploadUrlResp>(
    args.tenant_id,
    "files.getUploadURLExternal",
    { filename: args.filename, length: args.bytes.byteLength },
    args.team_id,
  );
  if (!reserve.upload_url || !reserve.file_id) {
    throw new Error("slack getUploadURLExternal returned no upload_url/file_id");
  }

  const form = new FormData();
  form.set(
    "file",
    new Blob([args.bytes as unknown as BlobPart]),
    args.filename,
  );
  const up = await fetch(reserve.upload_url, { method: "POST", body: form });
  if (!up.ok) {
    throw new Error(`slack upload POST returned HTTP ${up.status}`);
  }

  await slackFetch(
    args.tenant_id,
    "files.completeUploadExternal",
    {
      files: JSON.stringify([
        { id: reserve.file_id, title: args.title ?? args.filename },
      ]),
      channel_id: args.channel_id,
      thread_ts: args.thread_ts,
    },
    args.team_id,
  );

  return { file_id: reserve.file_id };
}
