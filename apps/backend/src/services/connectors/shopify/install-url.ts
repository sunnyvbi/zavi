function webOrigin(): string {
  return (process.env.WEB_ORIGIN || "http://localhost:3000").split(",")[0].trim();
}

export function installLandingUrl(token: string, origin: string = webOrigin()): string {
  return `${origin.replace(/\/$/, "")}/connectors/shopify/install?token=${encodeURIComponent(token)}`;
}

export function installErrorUrl(code: string, origin: string = webOrigin()): string {
  const qs = new URLSearchParams({ error: code });
  return `${origin.replace(/\/$/, "")}/connectors/shopify/install?${qs.toString()}`;
}
