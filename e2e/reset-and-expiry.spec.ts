import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const sessionDirectory = resolve("runtime-data/e2e-sessions");

test.describe.serial("reset, recipient isolation, expiry, and cleanup", () => {
  test.setTimeout(60_000);

  test("reset works from each operator phase and ignores stale capture and delivery work", async ({ context, page }) => {
    await openWelcome(page);
    await resetToWelcome(page);

    await startCapture(page);
    await expect(page.getByLabel("사진 촬영")).toBeVisible();
    await resetToWelcome(page);
    await page.waitForTimeout(500);
    await expect(page.getByRole("button", { name: "체험 시작" })).toBeVisible();

    await reachSelection(page);
    await resetToWelcome(page);

    await reachFrame(page);
    await resetToWelcome(page);

    await reachFrame(page);
    await page.getByRole("button", { name: "이 프레임으로 사진 만들기" }).click();
    await expect(page.getByLabel("사진 발급")).toBeVisible();
    await resetToWelcome(page);
    await page.waitForTimeout(3_000);
    await expect(page.getByTestId("delivery-url")).toHaveCount(0);

    const deliveryUrl = await issuePhoto(page);
    await resetToWelcome(page);
    const recipient = await context.newPage();
    await recipient.goto(deliveryUrl);
    await expect(recipient.getByAltText("완성된 네컷 사진")).toBeVisible();
    await recipient.close();

    await reachFrame(page);
    await context.setOffline(true);
    await page.getByRole("button", { name: "이 프레임으로 사진 만들기" }).click();
    await expect(page.getByRole("alert")).toBeVisible({ timeout: 20_000 });
    await context.setOffline(false);
    await resetToWelcome(page);
  });

  test("two recipient contexts decrypt the same issued session before expiry", async ({ browser, page }) => {
    const deliveryUrl = await issuePhoto(page);
    const firstContext = await browser.newContext();
    const secondContext = await browser.newContext();
    const first = await firstContext.newPage();
    const second = await secondContext.newPage();

    await Promise.all([first.goto(deliveryUrl), second.goto(deliveryUrl)]);
    await expect(first.getByAltText("완성된 네컷 사진")).toBeVisible();
    await expect(second.getByAltText("완성된 네컷 사진")).toBeVisible();

    await Promise.all([firstContext.close(), secondContext.close()]);
  });

  test("wrong keys and modified ciphertext never render a plaintext fallback", async ({ browser, page }) => {
    const deliveryUrl = await issuePhoto(page);
    const wrongKeyUrl = new URL(deliveryUrl);
    wrongKeyUrl.hash = "#key=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const wrongKeyContext = await browser.newContext();
    const wrongKeyRecipient = await wrongKeyContext.newPage();
    await wrongKeyRecipient.goto(wrongKeyUrl.toString());
    await expect(wrongKeyRecipient.getByText("사진을 열 수 없습니다")).toBeVisible();
    await expect(wrongKeyRecipient.getByAltText("완성된 네컷 사진")).toHaveCount(0);
    await wrongKeyContext.close();

    const modifiedContext = await browser.newContext();
    await modifiedContext.route("**/f/**", async (route) => {
      const response = await route.fetch();
      const ciphertext = Buffer.from(await response.body());
      ciphertext[ciphertext.length - 1] ^= 1;
      await route.fulfill({ response, body: ciphertext });
    });
    const modifiedRecipient = await modifiedContext.newPage();
    await modifiedRecipient.goto(deliveryUrl);
    await expect(modifiedRecipient.getByText("사진을 열 수 없습니다")).toBeVisible();
    await expect(modifiedRecipient.getByAltText("완성된 네컷 사진")).toHaveCount(0);
    await modifiedContext.close();
  });

  test("ciphertext storage contains no JPEG magic bytes and expires at expiresAt", async ({ browser, page }) => {
    const deliveryUrl = await issuePhoto(page);
    const entries = await readdir(sessionDirectory);
    const ciphertexts = entries.filter((entry) => entry.endsWith(".bin"));
    expect(ciphertexts.length).toBeGreaterThan(0);
    for (const ciphertext of ciphertexts) {
      const bytes = await readFile(resolve(sessionDirectory, ciphertext));
      expect(bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))).toBe(false);
    }

    await page.waitForTimeout(5_100);
    const expiredRecipient = await browser.newPage();
    const response = await expiredRecipient.goto(deliveryUrl);
    expect(response?.status()).toBe(410);
    await expect.poll(async () => readdir(sessionDirectory)).toEqual([]);
    await expiredRecipient.close();
  });

  test("operator shutdown purges an active session from the isolated directory", async ({ page, request }) => {
    const deliveryUrl = await issuePhoto(page);
    const token = new URL(deliveryUrl).pathname.split("/").at(-1)!;
    const sessionId = token.split(".")[1]!;
    await expect.poll(async () => readdir(sessionDirectory)).toEqual(expect.arrayContaining([
      `${sessionId}.bin`,
      `${sessionId}.json`,
    ]));

    const response = await request.post("/api/shutdown", { data: { confirm: "DELETE_ALL" } });
    expect(response.status()).toBe(202);
    await expect.poll(async () => readdir(sessionDirectory)).toEqual([]);
  });
});

async function openWelcome(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "체험 시작" })).toBeVisible();
}

async function startCapture(page: Page): Promise<void> {
  await page.getByRole("checkbox", { name: "모든 팀원이 촬영에 동의했습니다" }).check();
  await page.getByRole("button", { name: "체험 시작" }).click();
}

async function reachSelection(page: Page): Promise<void> {
  await openWelcome(page);
  await startCapture(page);
  await expect(page.getByAltText("촬영 사진 6")).toBeVisible();
}

async function reachFrame(page: Page): Promise<void> {
  await reachSelection(page);
  for (const number of [4, 1, 6, 3]) {
    await page.getByAltText(`촬영 사진 ${number}`).click();
  }
  await page.getByRole("button", { name: "프레임 선택하기" }).click();
  await page.getByRole("radio", { name: "기본 프레임" }).check();
  await expect(page.getByLabel("프레임 선택")).toBeVisible();
}

async function issuePhoto(page: Page): Promise<string> {
  await reachFrame(page);
  await page.getByRole("button", { name: "이 프레임으로 사진 만들기" }).click();
  const delivery = page.getByTestId("delivery-url");
  await expect(delivery).toBeAttached({ timeout: 15_000 });
  const url = await delivery.getAttribute("data-url");
  expect(url).toContain("#key=");
  return url!;
}

async function resetToWelcome(page: Page): Promise<void> {
  await page.getByRole("button", { name: "처음으로" }).click();
  await page.getByRole("button", { name: "확인" }).click();
  await expect(page.getByRole("button", { name: "체험 시작" })).toBeVisible();
}
