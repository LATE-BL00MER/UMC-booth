const MAGIC = new TextEncoder().encode("UMC1");
const NONCE_BYTES = 12;
const KEY_BYTES = 32;

export async function generatePhotoKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptPhoto(
  plain: Uint8Array,
  key: CryptoKey,
): Promise<Uint8Array> {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce },
      key,
      bufferSource(plain),
    ),
  );
  const envelope = new Uint8Array(MAGIC.length + nonce.length + ciphertext.length);
  envelope.set(MAGIC, 0);
  envelope.set(nonce, MAGIC.length);
  envelope.set(ciphertext, MAGIC.length + nonce.length);
  return bytesLike(envelope, plain);
}

export async function decryptPhoto(
  envelope: Uint8Array,
  key: CryptoKey,
): Promise<Uint8Array> {
  if (envelope.length <= MAGIC.length + NONCE_BYTES) {
    throw new Error("Invalid envelope");
  }
  if (!MAGIC.every((byte, index) => envelope[index] === byte)) {
    throw new Error("Unsupported envelope version");
  }
  const nonce = envelope.slice(MAGIC.length, MAGIC.length + NONCE_BYTES);
  const ciphertext = envelope.slice(MAGIC.length + NONCE_BYTES);
  return bytesLike(
    new Uint8Array(
      await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ciphertext),
    ),
    envelope,
  );
}

export async function exportKeyFragment(key: CryptoKey): Promise<string> {
  const rawKey = new Uint8Array(await crypto.subtle.exportKey("raw", key));
  return toBase64Url(rawKey);
}

export async function importKeyFragment(fragment: string): Promise<CryptoKey> {
  const rawKey = fromBase64Url(fragment);
  if (rawKey.length !== KEY_BYTES) {
    throw new Error("Invalid photo key");
  }
  return crypto.subtle.importKey("raw", bufferSource(rawKey), "AES-GCM", true, [
    "encrypt",
    "decrypt",
  ]);
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) {
    throw new Error("Invalid photo key");
  }
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function bytesLike(bytes: Uint8Array, reference: Uint8Array): Uint8Array {
  const Uint8ArrayFromReference = reference.constructor as new (
    values: Uint8Array,
  ) => Uint8Array;
  return new Uint8ArrayFromReference(bytes);
}

function bufferSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}
