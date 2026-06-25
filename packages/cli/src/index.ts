#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadEventModelProject } from "@emviz/parser";
import { diffEventModelProjects, readGraphSidecar, writeGraphSidecar, type GraphDiff } from "@emviz/graph";
import { validateEventModelProject } from "@emviz/validator";

const args = process.argv.slice(2);
const command = args[0];

function resolveTarget(value: string | undefined): string {
  return path.resolve(process.cwd(), value ?? ".");
}

function sendJson(res: { setHeader(name: string, value: string): void; end(body: string): void; statusCode: number }, value: unknown): void {
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(value));
}

function sendText(res: http.ServerResponse, statusCode: number, body: string): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.end(body);
}

function loadApiModel(targetDir: string): unknown {
  const project = loadEventModelProject(targetDir);
  return {
    ...project,
    graphSidecar: readGraphSidecar(project.root)
  };
}

type DiffSource = {
  project: ReturnType<typeof loadEventModelProject>;
  label: string;
};

type DiffServerState = {
  model: unknown;
  validation: ReturnType<typeof validateEventModelProject>;
  diff: GraphDiff;
};

function isGitRef(value: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--verify", `${value}^{commit}`], {
      cwd: process.cwd(),
      stdio: "ignore"
    });
    return true;
  } catch {
    return false;
  }
}

function materializeGitRef(ref: string): string {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "emviz-diff-"));
  const files = execFileSync("git", ["ls-tree", "-r", "--name-only", ref, "--", ".event-modeling", "event-model"], {
    cwd: process.cwd(),
    encoding: "utf8"
  })
    .split("\n")
    .filter(Boolean);

  if (files.length === 0) throw new Error(`Git ref "${ref}" does not contain .event-modeling or event-model files.`);

  for (const file of files) {
    const content = execFileSync("git", ["show", `${ref}:${file}`], {
      cwd: process.cwd(),
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024
    });
    const outputPath = path.join(tempRoot, file);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, content);
  }

  return tempRoot;
}

function loadDiffSource(value: string | undefined, fallback: string): DiffSource {
  const raw = value ?? fallback;
  const resolved = path.resolve(process.cwd(), raw);
  if (fs.existsSync(resolved)) {
    if (fs.statSync(resolved).isFile()) {
      throw new Error(`Diff source must be an event-modeling project directory, not a file: ${raw}`);
    }
    return {
      project: loadEventModelProject(resolved),
      label: path.relative(process.cwd(), resolved) || "."
    };
  }

  if (isGitRef(raw)) {
    const root = materializeGitRef(raw);
    return {
      project: loadEventModelProject(root),
      label: raw
    };
  }

  throw new Error(`Diff source not found as a path or git ref: ${raw}`);
}

function parseDiffArgs(values: string[]): { base: string; target: string } {
  let base: string | undefined;
  let target: string | undefined;
  const positional: string[] = [];

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--from") {
      base = values[index + 1];
      index += 1;
      continue;
    }
    if (value === "--to") {
      target = values[index + 1];
      index += 1;
      continue;
    }
    positional.push(value);
  }

  return {
    base: base ?? positional[0] ?? "HEAD~1",
    target: target ?? positional[1] ?? "."
  };
}

function loadDiffServerState(baseValue: string, targetValue: string): DiffServerState {
  const base = loadDiffSource(baseValue, "HEAD~1");
  const target = loadDiffSource(targetValue, ".");
  const result = diffEventModelProjects(base.project, target.project, {
    base: base.label,
    target: target.label
  });

  return {
    model: {
      ...result.project,
      graphSidecar: readGraphSidecar(target.project.root)
    },
    validation: validateEventModelProject(target.project),
    diff: result.diff
  };
}

function printSyncResult(result: ReturnType<typeof writeGraphSidecar>): void {
  console.log(`Wrote ${path.relative(process.cwd(), result.path)}`);
  console.log(`Added: ${result.added.length}`);
  console.log(`Preserved: ${result.preserved.length}`);
  console.log(`Stale: ${result.stale.length}`);
}

async function runSync(targetDir: string): Promise<void> {
  const project = loadEventModelProject(targetDir);
  const result = writeGraphSidecar(project);
  printSyncResult(result);
}

function syncMissingGraphSidecar(targetDir: string): void {
  const project = loadEventModelProject(targetDir);
  if (readGraphSidecar(project.root)) return;

  console.log("Missing .event-modeling/graph.json; running initial sync...");
  printSyncResult(writeGraphSidecar(project));
}

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function safeResolve(root: string, requestPath: string): string | undefined {
  const decodedPath = decodeURIComponent(requestPath);
  const resolved = path.resolve(root, `.${decodedPath}`);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  return resolved;
}

function serveFile(res: http.ServerResponse, filePath: string): void {
  const stream = fs.createReadStream(filePath);
  stream.on("error", () => sendText(res, 500, "Failed to read file"));
  res.setHeader("content-type", contentTypes[path.extname(filePath)] ?? "application/octet-stream");
  stream.pipe(res);
}

function serveApp(req: http.IncomingMessage, res: http.ServerResponse, appRoot: string): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  const requestPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = safeResolve(appRoot, requestPath);

  if (!filePath) {
    sendText(res, 403, "Forbidden");
    return;
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    serveFile(res, filePath);
    return;
  }

  if (requestPath.startsWith("/assets/")) {
    sendText(res, 404, "Not found");
    return;
  }

  serveFile(res, path.join(appRoot, "index.html"));
}

function listenWithFallback(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryListen = (nextPort: number) => {
      server.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE") {
          console.log(`Port ${nextPort} is in use, trying another one...`);
          tryListen(nextPort + 1);
          return;
        }
        reject(error);
      });
      server.listen(nextPort, "127.0.0.1", () => {
        resolve((server.address() as AddressInfo).port);
      });
    };

    tryListen(port);
  });
}

async function runServer(targetDir?: string, diffState?: DiffServerState): Promise<void> {
  if (targetDir) syncMissingGraphSidecar(targetDir);

  const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "app");
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (diffState && url.pathname === "/api/model") {
      sendJson(res, diffState.model);
      return;
    }

    if (diffState && url.pathname === "/api/diff") {
      sendJson(res, diffState.diff);
      return;
    }

    if (diffState && url.pathname === "/api/validation") {
      sendJson(res, diffState.validation);
      return;
    }

    if (targetDir && url.pathname === "/api/model") {
      try {
        sendJson(res, loadApiModel(targetDir));
      } catch (error) {
        res.statusCode = 500;
        sendJson(res, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (targetDir && url.pathname === "/api/validation") {
      try {
        const project = loadEventModelProject(targetDir);
        sendJson(res, validateEventModelProject(project));
      } catch (error) {
        res.statusCode = 500;
        sendJson(res, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    serveApp(req, res, appRoot);
  });

  const port = await listenWithFallback(server, 5173);
  console.log(`  ➜  Local:   http://localhost:${port}/`);
  if (diffState) {
    console.log(`Diff: ${diffState.diff.base.label} -> ${diffState.diff.target.label}`);
  } else {
    console.log(targetDir ? `Project: ${targetDir}` : "Mode: manual import");
  }
}

async function main(): Promise<void> {
  if (command === "sync") {
    await runSync(resolveTarget(args[1]));
    return;
  }

  if (command === "init") {
    console.warn("`emviz init` is deprecated. Use `emviz sync` instead.");
    await runSync(resolveTarget(args[1]));
    return;
  }

  if (command === "diff") {
    const diffArgs = parseDiffArgs(args.slice(1));
    const diffState = loadDiffServerState(diffArgs.base, diffArgs.target);
    await runServer(undefined, diffState);
    return;
  }

  if (command === "--help" || command === "-h") {
    console.log("Usage: emviz [project-dir]");
     console.log("       emviz sync [project-dir]");
    console.log("       emviz diff [base-ref-or-dir] [project-dir]");
    console.log("       emviz diff --from <base-ref-or-dir> --to <project-dir>");
    console.log("       emviz init [project-dir]  (deprecated alias for sync)");
    return;
  }

  await runServer(command ? resolveTarget(command) : undefined);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
