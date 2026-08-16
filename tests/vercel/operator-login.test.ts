import { afterEach, describe, expect, it } from "vitest";

import booth from "../../api/booth";

const originalPin = process.env.OPERATOR_PIN;
const originalSecret = process.env.OPERATOR_SECRET;

afterEach(() => {
  restore("OPERATOR_PIN", originalPin);
  restore("OPERATOR_SECRET", originalSecret);
});

describe("Vercel operator PIN login", () => {
  it("exchanges the configured PIN for the existing high-entropy operator key", async () => {
    process.env.OPERATOR_PIN = "1234";
    process.env.OPERATOR_SECRET = "s".repeat(48);

    const response = await booth.fetch(loginRequest({ pin: "1234" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ operatorKey: "s".repeat(48) });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("does not reveal whether the PIN or request shape was wrong", async () => {
    process.env.OPERATOR_PIN = "1234";
    process.env.OPERATOR_SECRET = "s".repeat(48);

    const wrongPin = await booth.fetch(loginRequest({ pin: "0000" }));
    const extraField = await booth.fetch(loginRequest({ pin: "1234", extra: true }));

    expect(wrongPin.status).toBe(404);
    expect(extraField.status).toBe(404);
    expect(await wrongPin.json()).toEqual({ error: "Not found" });
    expect(await extraField.json()).toEqual({ error: "Not found" });
  });
});

function loginRequest(body: unknown): Request {
  return new Request("https://booth.test/api/booth?route=operator-login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
