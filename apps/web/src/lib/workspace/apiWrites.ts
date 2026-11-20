type ApiWriteListener = (path: string) => void;

const listeners = new Set<ApiWriteListener>();

export function noteApiWrite(path: string): void {
  listeners.forEach((listener) => listener(path));
}

export function onApiWrite(listener: ApiWriteListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
