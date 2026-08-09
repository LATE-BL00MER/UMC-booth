import { describe, expect, it } from "vitest";
import { formatPublicToken, parsePublicToken } from "../../src/shared/public-token";

const sessionId = "AAAAAAAAAAAAAAAAAAAAAA";

describe("public tokens", () => {
  it("round-trips a base36 expiry and a 128-bit base64url session ID", () => {
    const token = formatPublicToken({ id: sessionId, expiresAt: 601_000 });

    expect(token).toBe("cvqg.AAAAAAAAAAAAAAAAAAAAAA");
    expect(parsePublicToken(token)).toEqual({ id: sessionId, expiresAt: 601_000 });
  });

  it.each([
    "cvqg.not-a-128-bit-id",
    "cvqg.AAAAAAAAAAAAAAAAAAAAAA.extra",
    "cvqg.AAAAAAAAAAAAAAAAAAAAAA/",
    "01.AAAAAAAAAAAAAAAAAAAAAA",
    "-1.AAAAAAAAAAAAAAAAAAAAAA",
    "not-base36.AAAAAAAAAAAAAAAAAAAAAA",
  ])("rejects malformed token %s", (token) => {
    expect(parsePublicToken(token)).toBeNull();
  });
});
