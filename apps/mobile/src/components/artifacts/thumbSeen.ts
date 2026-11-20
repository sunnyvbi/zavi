const seen = new Set<string>();

export const markThumbSeen = (id: string): void => {
  seen.add(id);
};

export const wasThumbSeen = (id: string): boolean => seen.has(id);
