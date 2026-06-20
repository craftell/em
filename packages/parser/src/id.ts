export function slugify(value: string): string {
  const normalized = value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();

  return normalized || "unnamed";
}

export function storyId(name: string): string {
  return `story_${slugify(name)}`;
}

export function sliceId(title: string): string {
  return `slc_${slugify(title).replaceAll("-", "_")}`;
}

export function screenId(sliceTitle: string, screenName?: string): string {
  return `scr_${slugify(screenName || sliceTitle).replaceAll("-", "_")}`;
}

export function commandId(name: string): string {
  return `cmd_${slugify(name).replaceAll("-", "_")}`;
}

export function queryId(name: string): string {
  return `qry_${slugify(name).replaceAll("-", "_")}`;
}

export function eventId(name: string): string {
  return `evt_${slugify(name).replaceAll("-", "_")}`;
}

export function edgeId(kind: string, source: string, target: string): string {
  return `${kind}:${source}->${target}`;
}

