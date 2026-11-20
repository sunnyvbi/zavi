
import { AsyncLocalStorage } from "node:async_hooks";

export type NodeCheckpointStore<T> = {
  get(key: string): Promise<T | null>;
  set(key: string, value: T | null): Promise<void>;
};

const scope = new AsyncLocalStorage<Record<string, unknown>>();

export function runWithNodeCheckpoints<R>(bag: Record<string, unknown>, fn: () => Promise<R>): Promise<R> {
  return scope.run(bag, fn);
}

function current(): Record<string, unknown> {
  const bag = scope.getStore();
  if (!bag) throw new Error("deploy checkpoints used outside a conductor deploy step");
  return bag;
}

export function nodePayloadCheckpoints<T>(): NodeCheckpointStore<T> {
  return {
    async get(key) {
      const v = current()[key];
      return v === undefined || v === null ? null : (JSON.parse(JSON.stringify(v)) as T);
    },
    async set(key, value) {
      const bag = current();
      if (value === null) delete bag[key];
      else bag[key] = JSON.parse(JSON.stringify(value)) as unknown;
    },
  };
}
