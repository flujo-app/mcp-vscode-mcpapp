import { readFile } from "node:fs/promises";
import process from "node:process";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const actualTag = process.argv[2];
const expectedTag = `v${packageJson.version}`;

if (actualTag !== expectedTag) {
  throw new Error(`Release tag ${JSON.stringify(actualTag)} does not match package version ${JSON.stringify(expectedTag)}`);
}

console.log(`Verified release tag ${actualTag}`);
