const USERNAME_RE = /^[a-z0-9](?:[a-z0-9._-]{1,30})[a-z0-9]$/;

export function validateUsername(raw: string) {
  const username = (raw ?? "").trim().toLowerCase();
  if (!USERNAME_RE.test(username)) return { ok: false as const, reason: "must be 3-32 characters, lowercase letters/digits/._-, starting and ending with an alphanumeric" };
  if (username.includes("..")) return { ok: false as const, reason: "no consecutive dots" };
  return { ok: true as const, username };
}

export function buildAddress(username: string, domain: string): string {
  return `${username}@${domain}`;
}