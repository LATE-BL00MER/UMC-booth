import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const entryPoint = resolve(root, "src/recipient/client.ts");
const css = await readFile(resolve(root, "src/recipient/page.css"), "utf8");
const result = await build({
  bundle: true,
  entryPoints: [entryPoint],
  format: "iife",
  globalName: "UMCRecipient",
  platform: "browser",
  target: "es2022",
  write: false,
});
const javascript = result.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const outputPath = resolve(root, "dist/recipient/index.html");
const document = `<!doctype html>
<html lang="ko">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark"><title>UMC 사진 받기</title><style>${css}</style></head>
<body><main class="recipient-page recipient-page--loading"><p class="recipient-brand">UMC PHOTO BOOTH</p><h1>사진을 안전하게 여는 중이에요</h1><p class="recipient-helper">암호화된 사진을 불러오고 있어요</p><span class="recipient-loader" aria-hidden="true"></span></main>__JOIN_CONFIG_SCRIPT__<script>${javascript}\nvoid UMCRecipient.bootstrapRecipientPage(document);</script></body>
</html>`;

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, document);
