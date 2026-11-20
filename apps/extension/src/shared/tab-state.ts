
const THREADS_KEY = "zv:tab-threads";
const FIRST_RUN_DISMISSED_KEY = "zv:first-run-dismissed";

type ThreadMap = Record<string, string>;

type SessionArea = {
  get(keys: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
};

function area(): SessionArea | null {
  const g = globalThis as unknown as {
    chrome?: { storage?: { session?: SessionArea } };
  };
  return g.chrome?.storage?.session ?? null;
}

async function readThreads(): Promise<ThreadMap> {
  const store = area();
  if (!store) return {};
  try {
    const bag = await store.get(THREADS_KEY);
    const value = bag?.[THREADS_KEY];
    return value && typeof value === "object" ? (value as ThreadMap) : {};
  } catch {
    return {};
  }
}

async function writeThreads(map: ThreadMap): Promise<void> {
  const store = area();
  if (!store) return;
  try {
    await store.set({ [THREADS_KEY]: map });
  } catch {
  }
}

export async function getTabThread(tabId: number): Promise<string | null> {
  const map = await readThreads();
  const found = map[String(tabId)];
  return typeof found === "string" && found ? found : null;
}

export async function setTabThread(
  tabId: number,
  threadId: string | null,
): Promise<void> {
  const map = await readThreads();
  const key = String(tabId);
  if (threadId === null) {
    if (!(key in map)) return;
    delete map[key];
  } else {
    if (map[key] === threadId) return;
    map[key] = threadId;
  }
  await writeThreads(map);
}

export async function forgetTab(tabId: number): Promise<void> {
  await setTabThread(tabId, null);
}

export async function firstRunDismissed(): Promise<boolean> {
  const store = area();
  if (!store) return false;
  try {
    const bag = await store.get(FIRST_RUN_DISMISSED_KEY);
    return bag?.[FIRST_RUN_DISMISSED_KEY] === true;
  } catch {
    return false;
  }
}

export async function dismissFirstRun(): Promise<void> {
  const store = area();
  if (!store) return;
  try {
    await store.set({ [FIRST_RUN_DISMISSED_KEY]: true });
  } catch {
  }
}
