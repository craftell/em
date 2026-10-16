import { spawn } from "node:child_process";

type Connection = { url: URL; token: string; agent?: string; positional: string[] };

export function parseConnection(values: string[]): Connection {
  const options = new Map<string, string>();
  const positional: string[] = [];
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (value.startsWith("--")) {
      if (!["--url", "--token", "--agent"].includes(value) || !values[index + 1]) throw new Error("Unknown or incomplete option: " + value);
      options.set(value, values[++index]);
    } else positional.push(value);
  }
  const url = new URL(options.get("--url") ?? "");
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(url.hostname) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("--url must be a loopback HTTP origin.");
  const token = options.get("--token");
  if (!token) throw new Error("--token is required. Use the token printed by emviz open.");
  return { url, token, agent: options.get("--agent"), positional };
}

export async function runAgentCommand(command: string, values: string[]): Promise<void> {
  const connection = parseConnection(values);
  if ((command === "poll" || command === "reply") && !connection.agent) throw new Error("--agent is required. Reuse one unique ID throughout the session.");
  const route = command === "poll" ? "/api/feedback/poll?agent=" + encodeURIComponent(connection.agent!) : "/api/feedback/" + command;
  const body = command === "reply" ? { id: connection.positional[0], reply: connection.positional[1], agent: connection.agent } : {};
  if (command === "reply" && connection.positional.length !== 2) throw new Error("Usage: emviz reply <request-id> <text> --url <url> --token <token> --agent <id>");
  if (command !== "reply" && connection.positional.length) throw new Error("Unexpected positional argument.");
  const response = await fetch(new URL(route, connection.url), {
    method: command === "poll" ? "GET" : "POST",
    headers: { "X-Emviz-Token": connection.token, "Content-Type": "application/json" },
    body: command === "poll" ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
    redirect: "error"
  });
  const result: unknown = await response.json();
  console.log(JSON.stringify(result));
  if (!response.ok) process.exitCode = 1;
}

export async function openProject(entry: string, target: string): Promise<void> {
  const child = spawn(process.execPath, [entry, "serve", target], { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error("Project server did not become ready within 15 seconds.")); }, 15000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error("Project server exited before readiness (" + code + "). Run emviz <project> in the foreground for diagnostics.")); });
    child.once("message", (message: unknown) => {
      if (!message || typeof message !== "object" || !("url" in message) || !("token" in message)) return;
      clearTimeout(timer);
      console.log(JSON.stringify(message));
      child.disconnect();
      child.unref();
      resolve();
    });
  });
}
