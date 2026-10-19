import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parseConfig } from "@emviz/parser";

export function materializeGitRef(ref: string, cwd = process.cwd()): string {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "emviz-diff-"));
  const files = execFileSync("git", ["ls-tree", "-r", "-z", "--name-only", ref, "--", ".event-modeling", "event-model"], {
    cwd,
    encoding: "utf8"
  })
    .split("\0")
    .filter(Boolean);

  if (files.includes(".event-modeling/config.yaml")) {
    const configText = execFileSync("git", ["show", `${ref}:.event-modeling/config.yaml`], {
      cwd, encoding: "utf8", maxBuffer: 20 * 1024 * 1024
    });
    const config = parseConfig(configText);
    for (const directory of [config.paths.featuresDir, config.paths.storiesDir]) {
      const normalized = path.posix.normalize(directory);
      if (path.isAbsolute(normalized) || normalized === ".." || normalized.startsWith("../")) {
        throw new Error("Model directories must stay inside the project directory.");
      }
      const tracked = execFileSync("git", ["ls-tree", "-r", "-z", "--name-only", ref, "--", normalized], {
        cwd, encoding: "utf8"
      }).split("\0").filter(Boolean);
      for (const file of tracked) {
        if ((file.endsWith(".yaml") || file.endsWith(config.paths.sliceExtension)) && !files.includes(file)) files.push(file);
      }
    }
    const actorsFile = path.posix.normalize(config.paths.actorsFile ?? path.posix.join(config.paths.eventModelDir, "actors.yaml"));
    if (path.isAbsolute(actorsFile) || actorsFile === ".." || actorsFile.startsWith("../")) {
      throw new Error("Actor registry must stay inside the project directory.");
    }
    if (!files.includes(actorsFile)) {
      const tracked = execFileSync("git", ["ls-tree", "-r", "-z", "--name-only", ref, "--", actorsFile], {
        cwd, encoding: "utf8"
      }).split("\0");
      if (tracked.includes(actorsFile)) files.push(actorsFile);
    }
  }

  if (files.length === 0) throw new Error(`Git ref "${ref}" does not contain .event-modeling or event-model files.`);

  for (const file of files) {
    const content = execFileSync("git", ["show", `${ref}:${file}`], {
      cwd,
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024
    });
    const outputPath = path.join(tempRoot, file);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, content);
  }

  return tempRoot;
}

