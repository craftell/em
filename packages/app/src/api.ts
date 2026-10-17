const tokenKey = "emviz.viewerToken";
let viewerToken: string | undefined;

function browserToken(): string | undefined {
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  if (fragment.has("token")) {
    const value = fragment.get("token") ?? "";
    viewerToken = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : undefined;
    try {
      if (viewerToken) window.sessionStorage.setItem(tokenKey, viewerToken);
      else window.sessionStorage.removeItem(tokenKey);
    } catch {}
    window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
  }
  if (!viewerToken) {
    try { viewerToken = window.sessionStorage.getItem(tokenKey) ?? undefined; } catch {}
  }
  return viewerToken;
}

export function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const url = new URL(path, window.location.href);
  if (url.origin !== window.location.origin || url.username || url.password || !url.pathname.startsWith("/api/")) {
    throw new Error("API requests must stay on this server.");
  }
  const headers = new Headers(init.headers);
  const token = browserToken();
  if (token && !headers.has("X-Emviz-Token")) headers.set("X-Emviz-Token", token);
  return fetch(url.href, { ...init, headers, redirect: "error" });
}

export function createClientRequestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20);
}
