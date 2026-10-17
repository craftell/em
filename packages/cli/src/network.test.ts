import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { apiRequestAuthorized, parseHost, parseHostArgs, serverOrigin, trustedRequest } from "./network.js";
import { parseConnection } from "./agent-cli.js";

const request = (host: string, origin?: string, token?: string | string[]) =>
  ({ headers: { host, origin, "x-emviz-token": token } }) as IncomingMessage;

describe("listener options", () => {
  it("keeps loopback as the default and formats concrete IPv4 and IPv6 origins", () => {
    expect(parseHost()).toBe("127.0.0.1");
    expect(parseHost("100.101.102.103")).toBe("100.101.102.103");
    expect(serverOrigin(parseHost("100.101.102.103"), 5174)).toBe("http://100.101.102.103:5174");
    expect(serverOrigin(parseHost("fd7a:115c:a1e0::1"), 5173)).toBe("http://[fd7a:115c:a1e0::1]:5173");
    expect(serverOrigin(parseHost("::1"), 5173)).toBe("http://[::1]:5173");
  });

  it.each(["", "0.0.0.0", "::", "0:0:0:0:0:0:0:0", "::ffff:0.0.0.0", "::ffff:0:0", "localhost", "device.example", "http://100.101.102.103", "100.101.102.103:5173", "::1%lo", " 127.0.0.1", "127.0.0.1\n"])("rejects invalid or unbounded listener %j", (host) => {
    expect(() => parseHost(host)).toThrow();
  });

  it("extracts either host syntax without consuming diff or project arguments", () => {
    expect(parseHostArgs([".", "--host", "100.101.102.103"])).toMatchObject({ host: "100.101.102.103", args: ["."], provided: true });
    expect(parseHostArgs(["--host=::1", "--from", "HEAD~1", "--to", "."])).toMatchObject({ host: "::1", args: ["--from", "HEAD~1", "--to", "."], provided: true });
    expect(parseHostArgs(["."])).toMatchObject({ host: "127.0.0.1", args: ["."], provided: false });
    expect(() => parseHostArgs(["--host"])).toThrow();
    expect(() => parseHostArgs(["--host", "127.0.0.1", "--host=::1"])).toThrow();
    expect(() => parseHostArgs(["--host", "--from", "HEAD"])).toThrow();
  });
});

describe("remote HTTP boundary", () => {
  const host = "100.101.102.103";
  const authority = host + ":5173";
  const token = "private-session-capability";

  it("accepts only the configured host, actual port, and matching origin", () => {
    expect(trustedRequest(request(authority), 5173, host)).toBe(true);
    expect(trustedRequest(request(authority, "http://" + authority), 5173, host)).toBe(true);
    for (const hostile of ["evil.example:5173", "localhost:5173", "127.0.0.1:5173", host + ":5174", authority + ".evil", authority + "@evil.example"]) {
      expect(trustedRequest(request(hostile), 5173, host)).toBe(false);
    }
    for (const origin of ["null", "https://" + authority, "http://evil.example:5173", "http://" + authority + "/", "http://" + authority + ".evil"]) {
      expect(trustedRequest(request(authority, origin), 5173, host)).toBe(false);
    }
  });

  it("matches bracketed IPv6 authorities without broadening the allowlist", () => {
    const ipv6 = parseHost("fd7a:115c:a1e0::1");
    expect(trustedRequest(request("[fd7a:115c:a1e0::1]:5173", "http://[fd7a:115c:a1e0::1]:5173"), 5173, ipv6)).toBe(true);
    expect(trustedRequest(request("[fd7a:115c:a1e0::2]:5173"), 5173, ipv6)).toBe(false);
    expect(trustedRequest(request("fd7a:115c:a1e0::1:5173"), 5173, ipv6)).toBe(false);
  });

  it.each(["/api/session", "/api/model", "/api/validation", "/api/diff", "/api/feedback/request", "/api/feedback/poll", "/api/feedback/close", "/api/unknown"])("requires capability before serving remote %s", (pathname) => {
    expect(apiRequestAuthorized(request(authority), pathname, host, token)).toBe(false);
    expect(apiRequestAuthorized(request(authority, undefined, "wrong"), pathname, host, token)).toBe(false);
    expect(apiRequestAuthorized(request(authority, undefined, [token, token]), pathname, host, token)).toBe(false);
    expect(apiRequestAuthorized(request(authority, undefined, token), pathname, host, token)).toBe(true);
  });

  it("allows static bootstrap files but preserves the local session bootstrap", () => {
    expect(apiRequestAuthorized(request(authority), "/", host, token)).toBe(true);
    expect(apiRequestAuthorized(request(authority), "/assets/app.js", host, token)).toBe(true);
    expect(apiRequestAuthorized(request("127.0.0.1:5173"), "/api/session", "127.0.0.1", token)).toBe(true);
  });
});

describe("agent destination", () => {
  it.each(["http://127.0.0.1:5173/", "http://localhost:5173/", "http://100.101.102.103:5173/", "http://[fd7a:115c:a1e0::1]:5173/"])("accepts concrete connection origin %s", (url) => {
    expect(parseConnection(["--url", url, "--token", "secret", "--agent", "owner"]).url.href).toBe(url);
  });

  it.each(["https://100.101.102.103:5173/", "http://device.example:5173/", "http://localhost.evil:5173/", "http://user:password@100.101.102.103:5173/", "http://100.101.102.103:5173/api/session", "http://100.101.102.103:5173/?token=secret", "http://100.101.102.103:5173/#token=secret", "http://0.0.0.0:5173/", "http://[::]:5173/"])("rejects unsafe connection destination %s", (url) => {
    expect(() => parseConnection(["--url", url, "--token", "secret"])).toThrow();
  });
});
