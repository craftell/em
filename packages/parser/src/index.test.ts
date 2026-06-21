import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadEventModelProject } from "./index.js";
import { loadEventModelProjectFromFiles, type InMemoryEventModelFile } from "./browser.js";
import { slugify } from "./id.js";

function expectUniqueNodeIds(project: { nodes: { id: string }[] }) {
  const ids = project.nodes.map((node) => node.id);
  expect(new Set(ids).size).toBe(ids.length);
}

function writeProjectFiles(root: string, files: InMemoryEventModelFile[]) {
  for (const file of files) {
    const target = path.join(root, file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.content);
  }
}

describe("loadEventModelProject", () => {
  it("loads the sample event model and builds a graph", () => {
    const project = loadEventModelProject(new URL("../../..", import.meta.url).pathname);

    expect(project.stories).toHaveLength(3);
    expect(project.slices).toHaveLength(7);
    expect(project.events).toHaveLength(11);
    expect(project.nodes.some((node) => node.id === "evt_customer_registered")).toBe(true);
    expect(project.nodes.some((node) => node.type === "gwt" && node.label === "Approval succeeds")).toBe(true);
    expect(project.edges.some((edge) => edge.kind === "command-event")).toBe(true);
    expect(project.edges.some((edge) => edge.kind === "event-query")).toBe(true);
    expectUniqueNodeIds(project);
  });

  it("loads the sample event model from uploaded file contents", () => {
    const root = new URL("../../..", import.meta.url).pathname;
    const relativePaths = [
      ".event-modeling/config.yaml",
      "event-model/events.yaml",
      ...fs
        .readdirSync(path.join(root, "event-model/stories"), { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".yaml"))
        .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join(path.posix.sep)),
      ...fs
        .readdirSync(path.join(root, "event-model/features"), { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".slice.yaml"))
        .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join(path.posix.sep))
    ];
    const files: InMemoryEventModelFile[] = relativePaths.map((filePath) => ({
      path: filePath,
      content: fs.readFileSync(path.join(root, filePath), "utf8")
    }));
    const project = loadEventModelProjectFromFiles(files);

    expect(project.stories).toHaveLength(3);
    expect(project.slices).toHaveLength(7);
    expect(project.nodes.some((node) => node.id === "evt_payment_collected")).toBe(true);
    expect(project.nodes.some((node) => node.type === "gwt" && node.label === "Missing context error")).toBe(true);
    expectUniqueNodeIds(project);
  });

  it("keeps graph node ids unique for non-ASCII names and repeated screen names", () => {
    const files: InMemoryEventModelFile[] = [
      {
        path: ".event-modeling/config.yaml",
        content: "language: ja\npaths:\n  event_model_dir: event-model\n"
      },
      {
        path: "event-model/events.yaml",
        content: "events: {}\n"
      },
      {
        path: "event-model/stories/scope.yaml",
        content: [
          "name: スコープ選択・認可",
          "slices:",
          "  - event-model/features/scope/staff/staff.slice.yaml",
          "  - event-model/features/scope/role/role.slice.yaml"
        ].join("\n")
      },
      {
        path: "event-model/stories/shift.yaml",
        content: [
          "name: シフトプランの作成と版管理",
          "slices:",
          "  - event-model/features/shift/create/create.slice.yaml"
        ].join("\n")
      },
      {
        path: "event-model/features/scope/staff/staff.slice.yaml",
        content: "slice: スタッフ管理\nscreen:\n  name: 管理画面\n"
      },
      {
        path: "event-model/features/scope/role/role.slice.yaml",
        content: "slice: ロール管理\nscreen:\n  name: 管理画面\n"
      },
      {
        path: "event-model/features/shift/create/create.slice.yaml",
        content: "slice: シフトプランの作成と版管理\nscreen:\n  name: 管理画面\n"
      }
    ];
    const browserProject = loadEventModelProjectFromFiles(files);
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "emviz-unicode-"));

    try {
      writeProjectFiles(tempRoot, files);
      const diskProject = loadEventModelProject(tempRoot);

      for (const project of [browserProject, diskProject]) {
        expect(project.nodes.filter((node) => node.type === "story")).toHaveLength(2);
        expect(project.nodes.filter((node) => node.type === "slice")).toHaveLength(3);
        expect(project.nodes.filter((node) => node.type === "screen")).toHaveLength(3);
        expect(project.nodes.some((node) => node.id === "story_unnamed")).toBe(false);
        expect(project.nodes.some((node) => node.id === "slc_unnamed")).toBe(false);
        expect(project.nodes.some((node) => node.id === "scr_unnamed")).toBe(false);
        expectUniqueNodeIds(project);
      }
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("slugifies Unicode letters and numbers instead of dropping them", () => {
    expect(slugify("AIによるシフト調整 (HITL)")).toBe("aiによるシフト調整-hitl");
    expect(slugify("スコープ選択・認可")).toBe("スコープ選択-認可");
  });
});
