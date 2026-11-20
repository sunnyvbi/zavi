import { useEffect, useRef, useState, type ReactNode } from "react";
import { ConfirmDialog } from "./ConfirmDialog";
import type { IconName } from "./Icon";

export type DialogOptions = {
  title: string;
  message: ReactNode;
  icon?: IconName;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
};

type Pending = DialogOptions & { resolve: (ok: boolean) => void };

let present: ((options: DialogOptions) => Promise<boolean>) | null = null;

export function showDialog(options: DialogOptions): Promise<boolean> {
  return present ? present(options) : Promise.resolve(false);
}

export function DialogHost() {
  const [dialog, setDialog] = useState<Pending | null>(null);
  const current = useRef<Pending | null>(null);

  useEffect(() => {
    present = (options) =>
      new Promise<boolean>((resolve) => {
        current.current?.resolve(false);
        current.current = { ...options, resolve };
        setDialog(current.current);
      });
    return () => {
      present = null;
    };
  }, []);

  function close(ok: boolean) {
    current.current?.resolve(ok);
    current.current = null;
    setDialog(null);
  }

  return (
    <ConfirmDialog
      visible={!!dialog}
      icon={dialog?.icon ?? "alertCircle"}
      title={dialog?.title ?? ""}
      message={dialog?.message ?? ""}
      cancelLabel={dialog?.cancelLabel}
      confirmLabel={dialog?.confirmLabel ?? "OK"}
      destructive={dialog?.destructive}
      onCancel={() => close(false)}
      onConfirm={() => close(true)}
    />
  );
}
