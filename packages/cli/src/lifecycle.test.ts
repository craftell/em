import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execute = promisify(execFile);
const entry = path.resolve(import.meta.dirname, "../dist/index.js");
const roots: string[] = [];
const connections: { url: string; token: string }[] = [];

async function cli(...args: string[]) {
  return execute(process.execPath, [entry, ...args], { timeout: 20000 });
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "emviz-host-test-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, ".event-modeling"), { recursive: true });
  fs.mkdirSync(path.join(root, "event-model/features"), { recursive: true });
  fs.writeFileSync(path.join(root, ".event-modeling/config.yaml"), "paths:\n  features_dir: event-model/features\n");
  fs.writeFileSync(path.join(root, "event-model/events.yaml"), "events:\n  Saved: {}\n");
  fs.writeFileSync(path.join(root, "event-model/features/save.slice.yaml"), "slice: Save\ncommands:\n  - name: Save\n    produces: [Saved]\n");
  return root;
}

async function open(args: string[]) {
  const result = await cli("open", ...args);
  const ready = JSON.parse(result.stdout) as { url: string; viewerUrl: string; token: string; pid: number };
  connections.push(ready);
  return ready;
}

afterEach(async () => {
  const failures: unknown[] = [];
  for (const connection of connections.splice(0)) {
    try { await cli("close", "--url", connection.url, "--token", connection.token); }
    catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, "Could not close owned test server.");
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("built CLI listener lifecycle", () => {
  it("keeps the default listener and legacy stop, poll, and close commands", async () => {
    const ready = await open([fixture()]);
    expect(new URL(ready.url).hostname).toBe("127.0.0.1");
    expect(ready.viewerUrl).toBe(ready.url);
    expect(ready.pid).toBeGreaterThan(0);
    const snapshot = await fetch(new URL("/api/session", ready.url)).then((response) => response.json()) as { token: string };
    expect(snapshot.token).toBe(ready.token);
    const stopped = await cli("stop", "--url", ready.url, "--token", ready.token);
    expect(JSON.parse(stopped.stdout).status).toBe("stopped");
    const polled = await cli("poll", "--url", ready.url, "--token", ready.token, "--agent", "host-test");
    expect(JSON.parse(polled.stdout).status).toBe("stopped");
  }, 30000);

  it("propagates an explicit host into the detached child and returned lifecycle origin", async () => {
    const ready = await open([fixture(), "--host", "127.0.0.2"]);
    expect(new URL(ready.url).hostname).toBe("127.0.0.2");
    expect(ready.viewerUrl).toBe(ready.url);
    expect((await fetch(new URL("/api/model", ready.url))).status).toBe(200);
    expect((await fetch(new URL("/api/model", ready.url), { headers: { Host: "localhost:" + new URL(ready.url).port } })).status).toBe(403);
    expect((await fetch(new URL("/api/model", ready.url), { headers: { Origin: "http://evil.example" } })).status).toBe(403);
    const stopped = await cli("stop", "--url", ready.url, "--token", ready.token);
    expect(JSON.parse(stopped.stdout).status).toBe("stopped");
  }, 30000);

  it("documents the opt-in host and rejects invalid hosts before sidecar creation", async () => {
    expect((await cli("--help")).stdout).toContain("--host");
    const root = fixture();
    await expect(cli("open", root, "--host", "0.0.0.0")).rejects.toThrow();
    await expect(cli("serve", root, "--host", "device.example")).rejects.toThrow();
    expect(fs.existsSync(path.join(root, ".event-modeling/graph.json"))).toBe(false);
  }, 30000);
});
