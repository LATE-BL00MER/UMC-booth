export interface ParsedPublicToken {
  id: string;
  expiresAt: number;
}

function isSessionId(value: string): boolean {
  if (!/^[A-Za-z0-9_-]{22}$/.test(value)) {
    return false;
  }

  try {
    const bytes = atob(`${value.replaceAll("-", "+").replaceAll("_", "/")}==`);
    return bytes.length === 16
      && btoa(bytes).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "") === value;
  } catch {
    return false;
  }
}

export function formatPublicToken({ id, expiresAt }: ParsedPublicToken): string {
  if (!isSessionId(id) || !Number.isSafeInteger(expiresAt) || expiresAt < 0) {
    throw new TypeError("Invalid public token fields");
  }
  return `${expiresAt.toString(36)}.${id}`;
}

export function parsePublicToken(token: string): ParsedPublicToken | null {
  const match = /^(0|[1-9a-z][0-9a-z]*)\.([A-Za-z0-9_-]{22})$/.exec(token);
  if (!match) {
    return null;
  }

  const expiryPart = match[1]!;
  const id = match[2]!;
  const expiresAt = Number.parseInt(expiryPart, 36);
  if (!Number.isSafeInteger(expiresAt) || expiresAt < 0 || expiresAt.toString(36) !== expiryPart || !isSessionId(id)) {
    return null;
  }

  return { id, expiresAt };
}
