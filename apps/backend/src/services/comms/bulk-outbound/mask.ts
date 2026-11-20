
export function maskAddress(email: string | null): string | null {
  if (!email) return email;
  const at = email.lastIndexOf("@");
  if (at < 1) return "•••";
  return `${email[0]}•••${email.slice(at)}`;
}
