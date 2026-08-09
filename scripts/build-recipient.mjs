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
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>UMC 사진 받기</title><style>${css}</style></head>
<body><main class="recipient-page"><h1>사진을 준비하는 중입니다</h1></main>__JOIN_CONFIG_SCRIPT__<script>${javascript}\nvoid UMCRecipient.bootstrapRecipientPage(document);</script></body>
</html>`;

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, document);
