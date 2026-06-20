import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { ModelConfig } from "./types.js";

type RawConfig = {
  language?: string;
  paths?: {
    event_model_dir?: string;
    features_dir?: string;
    slice_extension?: string;
    events_file?: string;
    stories_dir?: string;
  };
};

export function findProjectRoot(startDir: string): string {
  let current = path.resolve(startDir);

  while (true) {
    if (
      fs.existsSync(path.join(current, ".event-modeling")) ||
      fs.existsSync(path.join(current, ".git"))
    ) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return path.resolve(startDir);
    }
    current = parent;
  }
}

export function readConfig(projectRoot: string): ModelConfig {
  const configPath = path.join(projectRoot, ".event-modeling", "config.yaml");
  if (!fs.existsSync(configPath)) {
    throw new Error(`Missing .event-modeling/config.yaml at ${projectRoot}`);
  }

  const raw = YAML.parse(fs.readFileSync(configPath, "utf8")) as RawConfig | null;
  const eventModelDir = raw?.paths?.event_model_dir ?? "event-model";
  const featuresDir = raw?.paths?.features_dir ?? "src/features";
  const sliceExtension = raw?.paths?.slice_extension ?? ".slice.yaml";

  return {
    language: raw?.language,
    paths: {
      eventModelDir,
      featuresDir,
      sliceExtension,
      eventsFile: raw?.paths?.events_file ?? path.posix.join(eventModelDir, "events.yaml"),
      storiesDir: raw?.paths?.stories_dir ?? path.posix.join(eventModelDir, "stories")
    }
  };
}

