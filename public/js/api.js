// Thin client for the server's JSON API, plus the live-update stream.

async function req(method, url, body) {
  const init = { method, headers: {} };
  if (body instanceof Blob) {
    init.body = body;
    init.headers["Content-Type"] = "application/octet-stream";
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers["Content-Type"] = "application/json";
  }
  let res;
  try {
    res = await fetch(url, init);
  } catch {
    throw new Error("Could not reach the server. Check your connection and try again.");
  }
  const data = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

const enc = encodeURIComponent;

export const api = {
  state: () => req("GET", "/api/state"),
  createItem: (it) => req("POST", "/api/items", it),
  updateItem: (key, it) => req("PUT", `/api/items/${enc(key)}`, it),
  deleteItem: (key) => req("DELETE", `/api/items/${enc(key)}`),
  importItems: (rows) => req("POST", "/api/items/import", { rows }),
  removeDemo: () => req("POST", "/api/items/remove-demo"),
  addMove: (m) => req("POST", "/api/moves", m),
  createRule: (r) => req("POST", "/api/rules", r),
  updateRule: (id, r) => req("PUT", `/api/rules/${enc(id)}`, r),
  setRuleEnabled: (id, enabled) => req("PATCH", `/api/rules/${enc(id)}`, { enabled }),
  deleteRule: (id) => req("DELETE", `/api/rules/${enc(id)}`),
  saveSettings: (s) => req("PUT", "/api/settings", s),
  uploadFile: (file, meta) => req("POST", "/api/files?" + new URLSearchParams({ name: file.name, ...meta }), file),
  deleteFile: (id) => req("DELETE", `/api/files/${enc(id)}`),
  fileUrl: (id) => `/api/files/${enc(id)}/raw`,
  async fileBuffer(id) {
    const res = await fetch(`/api/files/${enc(id)}/raw`);
    if (!res.ok) throw new Error("File could not be fetched (" + res.status + ")");
    return res.arrayBuffer();
  },
  applyReports: (results, setStock) => req("POST", "/api/reports", { results, setStock }),
};

/** Calls onChange whenever anyone saves anything; onStatus gets "live" or "reconnecting". */
export function subscribe(onChange, onStatus) {
  const es = new EventSource("/api/events");
  es.addEventListener("change", onChange);
  es.onopen = () => onStatus("live");
  es.onerror = () => onStatus("reconnecting");
  return es;
}
