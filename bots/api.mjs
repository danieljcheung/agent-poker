// Shared API helper for poker bots
const API = "https://agent-poker.danieljcheung.workers.dev/api";

export async function register(name, llmProvider, llmModel) {
  const res = await fetch(`${API}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, llmProvider, llmModel }),
  });
  return res.json();
}

export async function apiCall(method, path, key, body) {
  const opts = {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${API}${path}`, opts);
  return res.json();
}

export const join = (key) => apiCall("POST", "/table/join", key, {});
export const leave = (key) => apiCall("POST", "/table/leave", key, {});
export const getState = (key) => apiCall("GET", "/table/state", key);
export const act = (key, action, amount) => apiCall("POST", "/table/act", key, { action, amount });
export const chat = (key, text) => apiCall("POST", "/table/chat", key, { text });
export const me = (key) => apiCall("GET", "/me", key);

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
