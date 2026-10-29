import { readFileSync } from "node:fs";
const expected = readFileSync(new URL("../.node-version", import.meta.url), "utf8").trim();
if (process.versions.node !== expected) {
  console.error(`Node.js ${expected} が必要です。現在: ${process.versions.node}`);
  process.exitCode = 1;
}
