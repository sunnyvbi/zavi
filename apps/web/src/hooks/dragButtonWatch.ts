const PRIMARY_BUTTON = 1;

export type DragButtonWatch = (buttons: number) => boolean;

export function createDragButtonWatch(): DragButtonWatch {
  let sawHeld = false;
  return (buttons: number) => {
    if ((buttons & PRIMARY_BUTTON) !== 0) {
      sawHeld = true;
      return true;
    }
    return !sawHeld;
  };
}
