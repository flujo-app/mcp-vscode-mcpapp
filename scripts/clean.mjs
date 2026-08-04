import { rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = path.resolve(process.cwd());
const dist = path.resolve(root, "dist");
if (path.dirname(dist) !== root || path.basename(dist) !== "dist") {
  throw new Error(`Refusing to remove unexpected path: ${dist}`);
}
await rm(dist, { recursive: true, force: true });
