export function slugify(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();

  return normalized || "unnamed";
}

export function storyId(sourcePath: string): string {
  return `story_${slugify(sourcePath).replaceAll("-", "_")}`;
}

export function sliceId(sourcePath: string): string {
  return `slc_${slugify(sourcePath).replaceAll("-", "_")}`;
}

export function screenId(slicePath: string): string {
  return `scr_${slugify(slicePath).replaceAll("-", "_")}`;
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

export function gwtId(slicePath: string, index: number, name?: string): string {
  const suffix = name ? slugify(name) : `case-${index + 1}`;
  return `gwt_${slugify(slicePath).replaceAll("-", "_")}_${suffix.replaceAll("-", "_")}`;
}

export function edgeId(kind: string, source: string, target: string): string {
  return `${kind}:${source}->${target}`;
}
