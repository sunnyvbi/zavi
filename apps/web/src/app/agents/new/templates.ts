export function forkableTemplates<T extends { custom?: boolean }>(agents: T[]): T[] {
  return agents.filter((a) => a.custom !== true);
}
