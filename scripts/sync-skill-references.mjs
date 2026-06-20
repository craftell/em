import { cp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(repoRoot, "skills", "_shared-source", "references");
const skills = ["em-model", "em-lint", "em-extract"];

for (const skill of skills) {
  const target = path.join(repoRoot, "skills", skill, "references");
  await rm(target, { recursive: true, force: true });
  await cp(source, target, { recursive: true });
  console.log(`synced ${path.relative(repoRoot, target)}`);
}
