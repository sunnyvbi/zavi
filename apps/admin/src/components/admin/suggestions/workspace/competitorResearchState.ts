export function isResearchableWebsite(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      !!url.hostname &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

export function matchesActiveResearch(args: {
  activeGeneration: number;
  responseGeneration: number;
  activeRequestId: string;
  responseRequestId: string;
  activeWebsite: string;
  responseWebsite: string;
}): boolean {
  return (
    args.activeGeneration === args.responseGeneration &&
    args.activeRequestId === args.responseRequestId &&
    args.activeWebsite === args.responseWebsite
  );
}

export function areProfileFieldsLocked(status: string): boolean {
  return status === "researching";
}
