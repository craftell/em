import { afterEach, describe, expect, it, vi } from "vitest";

const token = "12345678-1234-4234-8234-123456789abc";

function browser(hash = "", storage = new Map<string, string>()) {
  const location = new URL("http://100.80.1.2:5173/" + hash);
  const sessionStorage = {
    getItem: vi.fn((key: string) => storage.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { storage.set(key, value); }),
    removeItem: vi.fn((key: string) => { storage.delete(key); })
  };
  const history = {
    state: null,
    replaceState: vi.fn((_state: unknown, _title: string, url: string) => { location.href = new URL(url, location.href).href; })
  };
  vi.stubGlobal("window", { location, history, sessionStorage });
  const fetch = vi.fn().mockResolvedValue(new Response("{}"));
  vi.stubGlobal("fetch", fetch);
  return { location, history, sessionStorage, fetch, storage };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("browser API authorization", () => {
  it("takes the fragment token, clears the address bar, and authenticates all model requests", async () => {
    const state = browser("#token=" + token);
    const { apiFetch } = await import("./api");
    for (const path of ["/api/session", "/api/model", "/api/validation", "/api/diff"]) {
      await apiFetch(path);
    }
    expect(state.location.hash).toBe("");
    expect(state.history.replaceState).toHaveBeenCalledTimes(1);
    expect(state.sessionStorage.setItem).toHaveBeenCalledWith("emviz.viewerToken", token);
    for (const [url, init] of state.fetch.mock.calls) {
      expect(url).not.toContain(token);
      expect(new Headers(init.headers).get("X-Emviz-Token")).toBe(token);
      expect(init.redirect).toBe("error");
    }
  });

  it("retains the token in memory when tab storage is blocked", async () => {
    const state = browser("#token=" + token);
    state.sessionStorage.setItem.mockImplementation(() => { throw new Error("Blocked"); });
    state.sessionStorage.getItem.mockImplementation(() => { throw new Error("Blocked"); });
    const { apiFetch } = await import("./api");
    await apiFetch("/api/session");
    await apiFetch("/api/model");
    expect(state.location.hash).toBe("");
    expect(new Headers(state.fetch.mock.calls[1][1].headers).get("X-Emviz-Token")).toBe(token);
  });

  it("restores a tab token after a reload without a fragment", async () => {
    const first = browser("#token=" + token);
    await (await import("./api")).apiFetch("/api/session");
    vi.resetModules();
    const reloaded = browser("", first.storage);
    await (await import("./api")).apiFetch("/api/session");
    expect(new Headers(reloaded.fetch.mock.calls[0][1].headers).get("X-Emviz-Token")).toBe(token);
    expect(reloaded.history.replaceState).not.toHaveBeenCalled();
  });

  it("rejects a foreign destination before reading or sending the token", async () => {
    const state = browser("#token=" + token);
    const { apiFetch } = await import("./api");
    for (const path of ["http://evil.example/api/model", "//evil.example/api/session", "/assets/app.js", "http://user@100.80.1.2:5173/api/session"]) {
      expect(() => apiFetch(path)).toThrow("stay on this server");
    }
    expect(state.fetch).not.toHaveBeenCalled();
    expect(state.sessionStorage.getItem).not.toHaveBeenCalled();
    expect(state.sessionStorage.setItem).not.toHaveBeenCalled();
  });

  it("preserves a command token and refuses redirects even if a caller allows them", async () => {
    const state = browser("#token=" + token);
    const { apiFetch } = await import("./api");
    await apiFetch("/api/feedback/stop", { method: "POST", headers: { "X-Emviz-Token": "current-session", "Content-Type": "application/json" }, redirect: "follow" });
    const init = state.fetch.mock.calls[0][1];
    expect(new Headers(init.headers).get("X-Emviz-Token")).toBe("current-session");
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
    expect(init.redirect).toBe("error");
    expect(init.method).toBe("POST");
  });

  it("leaves default local requests unauthenticated and drops malformed fragment tokens", async () => {
    const state = browser("#token=invalid");
    const { apiFetch } = await import("./api");
    await apiFetch("/api/session");
    expect(state.location.hash).toBe("");
    expect(new Headers(state.fetch.mock.calls[0][1].headers).has("X-Emviz-Token")).toBe(false);
  });

  it("creates UUID request IDs without secure-context randomUUID", async () => {
    vi.stubGlobal("crypto", {
      getRandomValues: (bytes: Uint8Array) => {
        bytes.set(Array.from({ length: bytes.length }, (_, index) => index));
        return bytes;
      }
    });
    const { createClientRequestId } = await import("./api");
    expect(createClientRequestId()).toBe("00010203-0405-4607-8809-0a0b0c0d0e0f");
  });
});
