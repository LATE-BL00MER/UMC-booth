export interface PrivateApiClient {
  createPending(ciphertext: Uint8Array, signal: AbortSignal): Promise<{ id: string }>;
  activate(id: string, signal: AbortSignal): Promise<{ publicToken: string; expiresAt: number }>;
  getActivated(id: string): Promise<{ publicToken: string; expiresAt: number } | null>;
  deletePending(id: string): Promise<void>;
}

export class FetchPrivateApiClient implements PrivateApiClient {
  constructor(private readonly fetchFn: typeof fetch = fetch) {}

  async createPending(ciphertext: Uint8Array, signal: AbortSignal): Promise<{ id: string }> {
    const body = new ArrayBuffer(ciphertext.byteLength);
    new Uint8Array(body).set(ciphertext);
    const response = await this.fetchFn("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body,
      signal,
    });
    return readJson(response, "id", (value): value is { id: string } =>
      isRecord(value) && isString(value.id),
    );
  }

  async activate(id: string, signal: AbortSignal): Promise<{ publicToken: string; expiresAt: number }> {
    const response = await this.fetchFn(`/api/sessions/${encodeURIComponent(id)}/activate`, {
      method: "POST",
      signal,
    });
    return readJson(response, ["publicToken", "expiresAt"], (value): value is { publicToken: string; expiresAt: number } =>
      isRecord(value) && isString(value.publicToken) && isFiniteNumber(value.expiresAt),
    );
  }

  async getActivated(id: string): Promise<{ publicToken: string; expiresAt: number } | null> {
    const response = await this.fetchFn(`/api/sessions/${encodeURIComponent(id)}/activation`);
    if (response.status === 404) return null;
    return readJson(response, ["publicToken", "expiresAt"], (value): value is { publicToken: string; expiresAt: number } =>
      isRecord(value) && isString(value.publicToken) && isFiniteNumber(value.expiresAt),
    );
  }

  async deletePending(id: string): Promise<void> {
    const response = await this.fetchFn(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!response.ok) throw new Error(`Private API request failed (${response.status})`);
  }
}

async function readJson<T>(
  response: Response,
  required: string | readonly string[],
  isValid: (value: unknown) => value is T,
): Promise<T> {
  if (!response.ok) throw new Error(`Private API request failed (${response.status})`);
  const value: unknown = await response.json();
  if (!isValid(value)) {
    const fields = Array.isArray(required) ? required.join(", ") : required;
    throw new Error(`Private API response is missing ${fields}`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
