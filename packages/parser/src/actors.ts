import YAML from "yaml";
import type { ActorDefinition, ActorIssue, SliceModel } from "./types.js";

const palette = ["#2563EB", "#7C3AED", "#0F766E", "#B45309", "#BE185D", "#4338CA", "#047857", "#9F1239"];

export function actorColor(id: string): string {
  let hash = 0;
  for (const character of id) hash = (Math.imul(hash, 31) + character.codePointAt(0)!) >>> 0;
  return palette[hash % palette.length];
}

export function parseActorReferences(value: unknown): { actors: string[]; actorIssues?: string[] } {
  if (value === undefined) return { actors: [] };
  if (!Array.isArray(value)) return { actors: [], actorIssues: ["screen.actors must be an array of actor IDs."] };
  const actors: string[] = [];
  const actorIssues: string[] = [];
  for (const id of value) {
    if (typeof id !== "string" || !id.trim() || id !== id.trim()) {
      actorIssues.push("screen.actors IDs must be nonempty strings without surrounding whitespace.");
    } else if (actors.includes(id)) {
      actorIssues.push(`screen.actors lists "${id}" more than once.`);
    } else {
      actors.push(id);
    }
  }
  return { actors, ...(actorIssues.length ? { actorIssues } : {}) };
}

export function loadActors(content: string | undefined, sourcePath: string, slices: SliceModel[]): {
  actors: ActorDefinition[];
  actorIssues: ActorIssue[];
} {
  const definitions = new Map<string, ActorDefinition>();
  const actorIssues: ActorIssue[] = [];
  const issue = (message: string, path = sourcePath) => actorIssues.push({ message, path });
  if (content !== undefined) {
    let raw: unknown;
    try {
      raw = YAML.parse(content);
    } catch (error) {
      issue(`Invalid actor registry: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || !("actors" in raw) ||
        !raw.actors || typeof raw.actors !== "object" || Array.isArray(raw.actors)) {
      issue("Actor registry must contain an actors mapping.");
    } else {
      for (const [id, value] of Object.entries(raw.actors)) {
        if (!id.trim() || id !== id.trim()) {
          issue("Actor IDs must be nonempty strings without surrounding whitespace.");
          continue;
        }
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          issue(`Actor "${id}" must be a mapping with optional name and color.`);
          continue;
        }
        const entry = value as Record<string, unknown>;
        let name = id;
        let color = actorColor(id);
        if (entry.name !== undefined) {
          if (typeof entry.name !== "string" || !entry.name.trim()) issue(`Actor "${id}" name must be a nonempty string.`);
          else name = entry.name.trim();
        }
        if (entry.color !== undefined) {
          if (typeof entry.color !== "string" || !/^#[0-9a-f]{6}$/i.test(entry.color)) issue(`Actor "${id}" color must be a quoted #RRGGBB value.`);
          else color = entry.color.toUpperCase();
        }
        definitions.set(id, { id, name, color });
      }
    }
  }
  const registered = new Set(definitions.keys());
  for (const slice of slices) {
    for (const message of slice.screen.actorIssues ?? []) issue(message, slice.path);
    if (slice.screen.type !== "user") continue;
    for (const id of slice.screen.actors) {
      if (content !== undefined && !registered.has(id)) issue(`screen.actors references undefined actor "${id}".`, slice.path);
      if (!definitions.has(id)) definitions.set(id, { id, name: id, color: actorColor(id) });
    }
  }
  return { actors: [...definitions.values()], actorIssues };
}
