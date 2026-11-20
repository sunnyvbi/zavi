
export type StorageArea = {
  get(keys: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
};

export type AsyncStorageAdapter = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
};

export function createChromeStorageAdapter(area: StorageArea): AsyncStorageAdapter {
  return {
    async getItem(key: string): Promise<string | null> {
      try {
        const bag = await area.get(key);
        const value = bag?.[key];
        return typeof value === "string" ? value : null;
      } catch {
        return null;
      }
    },
    async setItem(key: string, value: string): Promise<void> {
      await area.set({ [key]: value });
    },
    async removeItem(key: string): Promise<void> {
      await area.remove(key);
    },
  };
}

export function chromeLocalStorageAdapter(): AsyncStorageAdapter {
  return createChromeStorageAdapter(chrome.storage.local as unknown as StorageArea);
}
