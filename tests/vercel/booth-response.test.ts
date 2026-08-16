import { describe, expect, it } from "vitest";

import { encryptedStreamResponse } from "../../api/booth";

describe("Vercel encrypted file response", () => {
  it("lets the runtime frame the streamed body instead of forcing a zero length", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3, 4]));
        controller.close();
      },
    });

    const response = encryptedStreamResponse(stream);

    expect(response.headers.get("content-length")).toBeNull();
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
  });
});
