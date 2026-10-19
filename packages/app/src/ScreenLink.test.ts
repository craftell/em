
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ScreenLink } from "./ScreenLink";
import type { ProjectNode } from "./types";

const screen: ProjectNode = { id: "screen", type: "screen", label: "Registration", screenType: "user" };
const render = (node: ProjectNode) => renderToStaticMarkup(createElement(ScreenLink, { node, compact: true }));

describe("screen reference links", () => {
  it("keeps legacy screens without extra controls", () => {
    expect(render(screen)).toBe("");
  });

  it("opens valid references separately with opener protection", () => {
    const html = render({ ...screen, url: "http://localhost:3000/design" });
    expect(html).toContain('href="http://localhost:3000/design"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("data-canvas-navigation-ignore");
    expect(html).toContain("Open reference for Registration in a new tab");
  });

  it("guards untrusted standalone/API values at rendering", () => {
    expect(render({ ...screen, url: "javascript:alert(1)" })).toBe("");
    expect(render({ ...screen, url: "https://user:pass@example.com/a" })).toBe("");
    expect(render({ ...screen, url: "//example.com" })).toBe("");
  });

  it("never renders Screen links on system or other nodes", () => {
    const url = "https://example.com";
    expect(render({ ...screen, url, screenType: "system" })).toBe("");
    expect(render({ ...screen, url, type: "processor" })).toBe("");
    expect(render({ ...screen, url, type: "command" })).toBe("");
  });
});
