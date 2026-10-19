import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

const run = promisify(execFile);
const skills = ["em-model", "em-lint", "em-extract"];

test("sync refreshes shared references and preserves skill-specific files on repeated runs", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "em-skill-sync-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "scripts"));
  const script = path.join(root, "scripts", "sync-skill-references.mjs");
  await cp(new URL("./sync-skill-references.mjs", import.meta.url), script);
  const source = path.join(root, "skills", "_shared-source", "references");
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, "yaml-format.md"), "current format\n");
  await writeFile(path.join(source, "checks.md"), "current checks\n");
  for (const skill of ["em-model", "em-extract"]) {
    const target = path.join(root, "skills", skill, "references");
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "yaml-format.md"), "stale format\n");
  }
  const extraction = path.join(root, "skills", "em-extract", "references");
  const state = await readFile(new URL("../skills/em-extract/references/extraction-state.md", import.meta.url));
  await writeFile(path.join(extraction, "extraction-state.md"), state);
  await mkdir(path.join(extraction, "local"));
  await writeFile(path.join(extraction, "local", "notes.md"), "skill-specific notes\n");

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await run(process.execPath, [script], { cwd: root });
    for (const skill of skills) {
      const target = path.join(root, "skills", skill, "references");
      assert.equal(await readFile(path.join(target, "yaml-format.md"), "utf8"), "current format\n");
      assert.equal(await readFile(path.join(target, "checks.md"), "utf8"), "current checks\n");
    }
    assert.deepEqual(await readFile(path.join(extraction, "extraction-state.md")), state);
    assert.equal(await readFile(path.join(extraction, "local", "notes.md"), "utf8"), "skill-specific notes\n");
  }
});
