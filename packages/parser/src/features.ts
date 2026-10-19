import YAML from "yaml";
import type { ModelIssue, StoryModel, TimelineModel } from "./types.js";

type SourceFile = { path: string; content: string };
type RecordValue = Record<string, unknown>;

function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

export function documentIssues(content: string, path: string, kind: string): ModelIssue[] {
  const raw: unknown = YAML.parse(content);
  if (!record(raw)) return [];
  const issues: ModelIssue[] = [];
  if (raw.kind !== undefined && raw.kind !== kind) {
    issues.push({ check: "F1", path, message: `Expected kind "${kind}", received "${String(raw.kind)}".` });
  }
  if (raw.schema_version !== undefined && raw.schema_version !== 1) {
    issues.push({ check: "F1", path, message: `Unsupported schema_version "${String(raw.schema_version)}". Supported version is 1.` });
  }
  if ((raw.kind === undefined) !== (raw.schema_version === undefined)) {
    issues.push({ check: "F1", path, message: "kind and schema_version must be supplied together." });
  }
  return issues;
}

export function parseFeatureFiles(files: SourceFile[]): { stories: StoryModel[]; timelines: TimelineModel[]; modelIssues: ModelIssue[] } {
  const stories: StoryModel[] = [];
  const timelines: TimelineModel[] = [];
  const modelIssues: ModelIssue[] = [];
  const featureIds = new Set<string>();
  for (const file of files) {
    const issue = (message: string) => modelIssues.push({ check: "F1", path: file.path, message });
    let raw: unknown;
    try {
      raw = YAML.parse(file.content);
    } catch (error) {
      issue(`Invalid feature YAML: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (!record(raw)) {
      issue("Feature document must be a mapping.");
      continue;
    }
    if (raw.kind !== "feature" || raw.schema_version !== 1) {
      issue('Feature document requires kind "feature" and schema_version 1.');
      continue;
    }
    if (!identifier(raw.id)) {
      issue("Feature requires a nonempty string id.");
      continue;
    }
    if (featureIds.has(raw.id)) {
      issue(`Duplicate feature id "${raw.id}".`);
      continue;
    }
    featureIds.add(raw.id);
    const featureIssueStart = modelIssues.length;
    if (!identifier(raw.name)) issue("Feature name must be a nonempty string without surrounding whitespace.");
    const featureName = identifier(raw.name) ? raw.name : file.path;
    const localStories = new Map<string, StoryModel>();
    if (!Array.isArray(raw.stories)) {
      issue("Feature stories must be an array.");
    } else {
      for (const entry of raw.stories) {
        if (!record(entry) || !identifier(entry.id)) {
          issue("Each story requires a nonempty string id.");
          continue;
        }
        if (localStories.has(entry.id)) {
          issue(`Duplicate story id "${entry.id}".`);
          continue;
        }
        if (!identifier(entry.name)) issue(`Story "${entry.id}" requires a nonempty name.`);
        const slices: string[] = [];
        if (!Array.isArray(entry.slices)) {
          issue(`Story "${entry.id}" slices must be an array.`);
        } else {
          for (const slice of entry.slices) {
            if (!identifier(slice) || slice.startsWith("/") || /^[A-Za-z]:/.test(slice) || slice.includes("\\") || slice.split("/").includes("..")) {
              issue(`Story "${entry.id}" slice references must be project-relative paths without parent traversal.`);
              continue;
            }
            const normalized = slice.split("/").filter((part) => part && part !== ".").join("/");
            if (slices.includes(normalized)) issue(`Story "${entry.id}" repeats slice "${normalized}".`);
            else slices.push(normalized);
          }
        }
        const story: StoryModel = {
          id: JSON.stringify([raw.id, entry.id]),
          localId: entry.id,
          featureName,
          name: identifier(entry.name) ? entry.name : entry.id,
          description: typeof entry.description === "string" ? entry.description : "",
          path: file.path,
          slices
        };
        localStories.set(entry.id, story);
        stories.push(story);
      }
    }
    if (modelIssues.length > featureIssueStart) continue;
    if (!Array.isArray(raw.timelines)) {
      issue("Feature timelines must be an array.");
      continue;
    }
    const timelineIds = new Set<string>();
    for (const entry of raw.timelines) {
      const issueStart = modelIssues.length;
      if (!record(entry) || !identifier(entry.id)) {
        issue("Each timeline requires a nonempty string id.");
        continue;
      }
      if (timelineIds.has(entry.id)) {
        issue(`Duplicate timeline id "${entry.id}".`);
        continue;
      }
      timelineIds.add(entry.id);
      if (!identifier(entry.name)) issue(`Timeline "${entry.id}" requires a nonempty name.`);
      if (!Array.isArray(entry.steps) || entry.steps.length === 0) {
        issue(`Timeline "${entry.id}" steps must be a nonempty array.`);
        continue;
      }
      const steps: TimelineModel["steps"] = [];
      const stepIds = new Set<string>();
      const usedStories = new Set<string>();
      const usedSlices = new Set<string>();
      for (const step of entry.steps) {
        if (!record(step) || !identifier(step.id)) {
          issue(`Timeline "${entry.id}" requires a string id for every step.`);
          continue;
        }
        if (stepIds.has(step.id)) issue(`Timeline "${entry.id}" repeats step id "${step.id}".`);
        stepIds.add(step.id);
        const story = typeof step.story === "string" ? localStories.get(step.story) : undefined;
        if (!story) {
          issue(`Timeline "${entry.id}" step "${step.id}" references unknown story "${String(step.story)}".`);
          continue;
        }
        if (usedStories.has(story.id!)) issue(`Timeline "${entry.id}" repeats story "${step.story}". Use separate timelines for alternative presentations.`);
        usedStories.add(story.id!);
        for (const slice of story.slices) {
          if (usedSlices.has(slice)) issue(`Timeline "${entry.id}" repeats slice "${slice}" across stories.`);
          usedSlices.add(slice);
        }
        const after: string[] = [];
        if (step.after !== undefined) {
          if (!Array.isArray(step.after) || !step.after.every(identifier)) {
            issue(`Timeline "${entry.id}" step "${step.id}" after must be an array of step ids.`);
          } else {
            for (const predecessor of step.after) {
              if (after.includes(predecessor)) issue(`Step "${step.id}" repeats predecessor "${predecessor}".`);
              else after.push(predecessor);
            }
          }
        }
        steps.push({ id: step.id, storyId: story.id!, after });
      }
      for (const step of steps) {
        for (const predecessor of step.after) {
          if (!stepIds.has(predecessor)) issue(`Step "${step.id}" references unknown predecessor "${predecessor}".`);
        }
      }
      const pending = new Set(steps.map((step) => step.id));
      while (pending.size > 0) {
        const ready = steps.filter((step) => pending.has(step.id) && step.after.every((id) => !pending.has(id)));
        if (ready.length === 0) {
          issue(`Timeline "${entry.id}" contains a layout cycle involving ${[...pending].join(", ")}.`);
          break;
        }
        for (const step of ready) pending.delete(step.id);
      }
      if (modelIssues.length === issueStart) {
        timelines.push({
          id: JSON.stringify([raw.id, entry.id]),
          name: entry.name as string,
          path: file.path,
          steps
        });
      }
    }
  }
  return { stories, timelines, modelIssues };
}
