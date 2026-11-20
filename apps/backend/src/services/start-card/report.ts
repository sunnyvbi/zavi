
import psl from "psl";

const FREEMAIL = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com",
  "yahoo.com", "ymail.com", "icloud.com", "me.com", "mac.com", "aol.com", "proton.me",
  "protonmail.com", "gmx.com", "gmx.de", "mail.com", "zoho.com", "yandex.com", "yandex.ru",
  "qq.com", "163.com", "rediffmail.com", "hey.com", "fastmail.com", "tutanota.com",
]);

function clean(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
}

const SHARED_HOSTS_NOT_IN_PSL = new Set(["squarespace.com", "substack.com", "lovable.app", "bubbleapps.io", "wordpress.com"]);

export function registrableDomain(host: string): string | null {
  const h = clean(host);
  const labels = h.split(".").filter(Boolean);
  for (let i = 1; i < labels.length; i++) {
    if (SHARED_HOSTS_NOT_IN_PSL.has(labels.slice(i).join("."))) return labels.slice(i - 1).join(".");
  }
  if (SHARED_HOSTS_NOT_IN_PSL.has(h)) return null;
  return psl.get(h);
}

export function emailCanRemove(email: string, cardDomain: string): boolean {
  const at = email.lastIndexOf("@");
  if (at < 1) return false;
  const emailHost = clean(email.slice(at + 1));
  const card = clean(cardDomain);
  if (!emailHost || !card || FREEMAIL.has(emailHost)) return false;
  const reg = registrableDomain(card);
  if (!reg) return false;
  return registrableDomain(emailHost) === reg;
}
