
const BACKEND_URL =
  (typeof process !== "undefined" && process.env.NEXT_PUBLIC_BACKEND_URL) ||
  "http://localhost:3001";

export function apiUrl(path: string): string {
  if (!path.startsWith("/")) {
    throw new Error(`apiUrl path must start with '/', got: ${path}`);
  }
  return `${BACKEND_URL}${path}`;
}
