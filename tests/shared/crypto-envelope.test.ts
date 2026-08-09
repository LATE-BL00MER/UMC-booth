import { describe, expect, it } from "vitest";
import {
  decryptPhoto,
  encryptPhoto,
  exportKeyFragment,
  generatePhotoKey,
  importKeyFragment,
} from "../../src/shared/crypto-envelope";

describe("photo crypto envelope", () => {
  it("round-trips JPEG bytes through an exported key", async () => {
    const source = new TextEncoder().encode("jpeg-fixture");
    const key = await generatePhotoKey();
    const envelope = await encryptPhoto(source, key);
    const restoredKey = await importKeyFragment(await exportKeyFragment(key));
    expect(await decryptPhoto(envelope, restoredKey)).toEqual(source);
  });

  it("uses a new nonce for every encryption", async () => {
    const key = await generatePhotoKey();
    const source = new Uint8Array([1, 2, 3]);
    expect(await encryptPhoto(source, key)).not.toEqual(
      await encryptPhoto(source, key),
    );
  });

  it("rejects a modified ciphertext", async () => {
    const key = await generatePhotoKey();
    const envelope = await encryptPhoto(new Uint8Array([7, 8, 9]), key);
    const lastByte = envelope.length - 1;
    envelope[lastByte] = envelope[lastByte]! ^ 1;
    await expect(decryptPhoto(envelope, key)).rejects.toThrow();
  });
});
