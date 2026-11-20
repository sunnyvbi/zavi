import { ConfirmDialog } from "./ConfirmDialog";

export function MicrophonePermissionDialog({
  mode,
  onRespond,
}: {
  mode: "rationale" | "settings" | null;
  onRespond: (accepted: boolean) => void;
}) {
  const needsSettings = mode === "settings";
  return (
    <ConfirmDialog
      visible={mode !== null}
      icon="mic"
      title={needsSettings ? "Enable microphone" : "Use your microphone"}
      message={
        needsSettings
          ? "Allow microphone access in Settings to turn your voice into a message. You can keep typing instead."
          : "Turn your voice into a message. You can review and edit the text before sending."
      }
      cancelLabel="Not now"
      confirmLabel={needsSettings ? "Open settings" : "Continue"}
      onCancel={() => onRespond(false)}
      onConfirm={() => onRespond(true)}
    />
  );
}
