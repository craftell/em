#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadEventModelProject } from "@emviz/parser";
import { materializeGitRef } from "./gitSources.js";
import { diffEventModelProjects, readGraphSidecar, writeGraphSidecar, type GraphDiff } from "@emviz/graph";
import { validateEventModelProject } from "@emviz/validator";
import { FeedbackSession, handleFeedback, readSnapshot } from "./feedback.js";
import { apiRequestAuthorized, isLoopbackHost, parseHostArgs, serverOrigin, trustedRequest } from "./network.js";
import { openProject, runAgentCommand } from "./agent-cli.js";

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

function listenWithFallback(server: http.Server, port: number, host: string): Promise<number> {
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
      server.listen(nextPort, host, () => {
        resolve((server.address() as AddressInfo).port);
      });
    };

    tryListen(port);
  });
}

async function runServer(host: string, targetDir?: string, diffState?: DiffServerState): Promise<void> {
  if (targetDir) {
    const initial = readSnapshot(targetDir);
    if (!initial.graphSidecar) {
      console.log("Missing .event-modeling/graph.json; running initial sync...");
      printSyncResult(writeGraphSidecar(initial.project));
    }
  }

  const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "app");
  const feedback = targetDir ? new FeedbackSession(targetDir) : undefined;
  const token = feedback?.token ?? randomUUID();
  let listeningPort = 0;
  const server = http.createServer((req, res) => {
    void respond(req, res).catch((error) => {
      if (!res.headersSent) sendText(res, 500, error instanceof Error ? error.message : String(error));
      else res.end();
    });
  });
  server.requestTimeout = 10000;
  const close = () => {
    feedback?.stop();
    server.close();
    server.closeIdleConnections();
    const timer = setTimeout(() => server.closeAllConnections(), 1000);
    timer.unref();
  };
  const respond = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    res.setHeader("cache-control", "no-store");
    res.setHeader("referrer-policy", "no-referrer");
    if (!trustedRequest(req, listeningPort, host)) { sendText(res, 403, "Forbidden Host or Origin"); return; }
    const url = new URL(req.url ?? "/", serverOrigin(host, listeningPort));
    if (!apiRequestAuthorized(req, url.pathname, host, token)) {
      res.statusCode = 403;
      sendJson(res, { error: "Invalid session token. Open the complete viewerUrl printed by emviz in this browser." });
      return;
    }
    if (feedback && await handleFeedback(req, res, feedback, close)) return;

    if (req.method !== "GET" && req.method !== "HEAD") { sendText(res, 405, "Method not allowed"); return; }

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
        const snapshot = feedback!.snapshot("current");
        if (snapshot.stale) res.statusCode = 422;
        sendJson(res, snapshot.project);
      } catch (error) {
        res.statusCode = 500;
        sendJson(res, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (targetDir && url.pathname === "/api/validation") {
      try {
        const snapshot = feedback!.snapshot("current");
        if (snapshot.stale) res.statusCode = 422;
        sendJson(res, snapshot.validation);
      } catch (error) {
        res.statusCode = 500;
        sendJson(res, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (url.pathname.startsWith("/api/")) { sendText(res, 404, "Not found"); return; }
    serveApp(req, res, appRoot);
  };

  const port = await listenWithFallback(server, 5173, host);
  listeningPort = port;
  const url = serverOrigin(host, port) + "/";
  const viewerUrl = isLoopbackHost(host) ? url : url + "#token=" + encodeURIComponent(token);
  if (feedback) {
    const ready = { url, viewerUrl, token, pid: process.pid, next_step: `Run emviz poll --url ${url} --token ${token} --agent <unique-agent-id> in your external agent.` };
    if (process.send) process.send(ready);
    else console.log(JSON.stringify(ready));
  }
  process.once("SIGTERM", close);
  process.once("SIGINT", close);
  console.log(`  ➜  ${isLoopbackHost(host) ? "Local" : "Remote"}:   ${viewerUrl}`);
  if (!isLoopbackHost(host)) console.warn("Remote access requires the complete viewerUrl. Treat that link and the token as secrets. HTTP is unencrypted; use a trusted private network such as Tailscale.");
  if (diffState) {
    console.log(`Diff: ${diffState.diff.base.label} -> ${diffState.diff.target.label}`);
  } else {
    console.log(targetDir ? `Project: ${targetDir}` : "Mode: manual import");
  }
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  if (["poll", "reply", "stop", "close"].includes(rawArgs[0])) {
    await runAgentCommand(rawArgs[0], rawArgs.slice(1));
    return;
  }
  const { host, args, provided } = parseHostArgs(rawArgs);
  const command = args[0];
  if (provided && ["sync", "init", "poll", "reply", "stop", "close"].includes(command)) throw new Error("--host is only supported by server commands.");
  if (command === "open") {
    if (args.length > 2) throw new Error("Usage: emviz open [project-dir] [--host <ip>]");
    await openProject(fileURLToPath(import.meta.url), resolveTarget(args[1]), host);
    return;
  }
  if (command === "serve") {
    if (args.length > 2) throw new Error("Usage: emviz serve [project-dir] [--host <ip>]");
    await runServer(host, resolveTarget(args[1]));
    return;
  }
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
    await runServer(host, undefined, diffState);
    return;
  }

  if (command === "--help" || command === "-h") {
    console.log("Usage: emviz [project-dir] [--host <ip>]");
    console.log("       emviz open [project-dir] [--host <ip>]");
    console.log("       emviz serve [project-dir] [--host <ip>]");
    console.log("       emviz poll --url <url> --token <token> --agent <id>");
    console.log("       emviz reply <request-id> <text> --url <url> --token <token> --agent <id>");
    console.log("       emviz stop|close --url <url> --token <token>");
    console.log("       emviz sync [project-dir]");
    console.log("       emviz diff [base-ref-or-dir] [project-dir] [--host <ip>]");
    console.log("       emviz diff --from <base-ref-or-dir> --to <project-dir> [--host <ip>]");
    console.log("       emviz init [project-dir]  (deprecated alias for sync)");
    console.log("Default host: 127.0.0.1. Use a concrete IPv4 or IPv6 interface address. DNS names and wildcard binds are rejected.");
    console.log("Remote browser access uses the printed viewerUrl. Agent commands use url and --token.");
    return;
  }

  if (args.length > 1 || command?.startsWith("-")) throw new Error("Usage: emviz [project-dir] [--host <ip>]");
  await runServer(host, command ? resolveTarget(command) : undefined);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
