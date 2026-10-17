import { isIP } from "node:net";
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export function parseHost(value = "127.0.0.1"): string {
  const host = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  const family = isIP(host);
  if (!family || (value.startsWith("[") && family !== 6) || host.includes("%")) throw new Error("--host must be a concrete IPv4 or IPv6 address. DNS names and wildcard addresses are not supported.");
  const normalized = family === 6 ? new URL("http://[" + host + "]/").hostname.slice(1, -1) : host;
  if (normalized === "0.0.0.0" || normalized === "::" || normalized === "::ffff:0:0") {
    throw new Error("--host must select one interface address. Wildcard addresses are not supported.");
  }
  return normalized;
}

export function parseHostArgs(values: string[]): { host: string; args: string[]; provided: boolean } {
  let host = "127.0.0.1";
  let provided = false;
  const args: string[] = [];
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (value !== "--host" && !value.startsWith("--host=")) {
      args.push(value);
      continue;
    }
    if (provided) throw new Error("--host may be specified only once.");
    const address = value === "--host" ? values[++index] : value.slice("--host=".length);
    if (!address || address.startsWith("--")) throw new Error("--host requires an IPv4 or IPv6 address.");
    host = parseHost(address);
    provided = true;
  }
  return { host, args, provided };
}

export function isLoopbackHost(host: string): boolean {
  return host === "::1" || host.startsWith("127.");
}

export function serverOrigin(host: string, port: number): string {
  return "http://" + (host.includes(":") ? "[" + host + "]" : host) + ":" + port;
}

export function trustedRequest(req: IncomingMessage, port: number, host = "127.0.0.1"): boolean {
  const authority = new URL(serverOrigin(host, port)).host;
  const allowed = host === "127.0.0.1" ? [authority, "localhost:" + port] : [authority];
  const requestHost = req.headers.host;
  if (!requestHost || !allowed.includes(requestHost)) return false;
  const origin = req.headers.origin;
  return origin === undefined || origin === "http://" + requestHost;
}

export function validToken(req: IncomingMessage, expected: string): boolean {
  const token = req.headers["x-emviz-token"];
  if (typeof token !== "string") return false;
  const actual = Buffer.from(token);
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

export function apiRequestAuthorized(req: IncomingMessage, pathname: string, host: string, token: string): boolean {
  return isLoopbackHost(host) || (pathname !== "/api" && !pathname.startsWith("/api/")) || validToken(req, token);
}
