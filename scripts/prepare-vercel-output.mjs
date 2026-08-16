import { copyFile, cp, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, "dist/operator");

await Promise.all([
  mkdir(resolve(output, "frame-pack"), { recursive: true }),
  mkdir(resolve(output), { recursive: true }),
]);

await Promise.all([
  cp(resolve(root, "assets/frame-packs"), resolve(output, "frame-pack"), {
    recursive: true,
    force: true,
  }),
  copyFile(resolve(root, "assets/poses/poses.json"), resolve(output, "poses.json")),
]);
