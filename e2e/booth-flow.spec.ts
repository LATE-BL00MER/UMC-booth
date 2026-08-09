import { expect, test } from "@playwright/test";

test("six captures become a four-photo encrypted download and CTA", async ({ browser, page }) => {
  await page.goto("/");
  await page.getByRole("checkbox", { name: "모든 팀원이 촬영에 동의했습니다" }).check();
  await page.getByRole("button", { name: "체험 시작" }).click();
  await expect(page.getByAltText("촬영 사진 6")).toBeVisible();
  for (const number of [4, 1, 6, 3]) {
    await page.getByAltText(`촬영 사진 ${number}`).click();
  }
  await page.getByRole("button", { name: "프레임 선택하기" }).click();
  await page.getByRole("radio", { name: "기본 프레임" }).click();
  await page.getByRole("button", { name: "이 프레임으로 사진 만들기" }).click();
  const deliveryUrl = await page.getByTestId("delivery-url").getAttribute("data-url");
  expect(deliveryUrl).toContain("#key=");

  const recipient = await browser.newPage();
  await recipient.goto(deliveryUrl!);
  await expect(recipient.getByAltText("완성된 네컷 사진")).toBeVisible();
  await expect(recipient.getByRole("link", { name: "지원 페이지 보기" })).toHaveCount(0);
  await recipient.getByRole("button", { name: "사진 저장하기" }).click();
  await expect(recipient.getByRole("link", { name: "지원 페이지 보기" })).toBeVisible();
});
