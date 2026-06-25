#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEventModelProject } from "@emviz/parser";
import { readGraphSidecar, writeGraphSidecar } from "@emviz/graph";
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

async function runServer(targetDir?: string): Promise<void> {
  if (targetDir) syncMissingGraphSidecar(targetDir);

  const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "app");
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

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
  console.log(targetDir ? `Project: ${targetDir}` : "Mode: manual import");
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

  if (command === "--help" || command === "-h") {
    console.log("Usage: emviz [project-dir]");
    console.log("       emviz sync [project-dir]");
    console.log("       emviz init [project-dir]  (deprecated alias for sync)");
    return;
  }

  await runServer(command ? resolveTarget(command) : undefined);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
