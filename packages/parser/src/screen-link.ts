import type { ModelIssue, ScreenModel } from "./types.js";

export function safeScreenUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^https?:\/\/[^/@]/i.test(value) || /[\s\u0000-\u001f\u007f\\]/u.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || !url.hostname || url.username || url.password) return undefined;
    if (value.split(/[/?#]/)[2].includes("@")) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

export function parseScreenLink(raw: unknown, path = ""): {
  link: Pick<ScreenModel, "url">;
  issues: ModelIssue[];
} {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !Object.hasOwn(raw, "url")) return { link: {}, issues: [] };
  const screen = raw as Record<string, unknown>;
  const url = safeScreenUrl(screen.url);
  if (screen.type !== "system" && url !== undefined) return { link: { url }, issues: [] };
  const message = screen.type === "system"
    ? "screen.url is only supported on user screens."
    : "screen.url must be an absolute HTTP or HTTPS URL without credentials, whitespace, or control characters.";
  return { link: {}, issues: [{ check: "L10", path, message }] };
}
