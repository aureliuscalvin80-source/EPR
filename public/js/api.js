// Thin client for the server's JSON API, plus the live-update stream.

let onUnauthorized = () => {};
/** Called when the server says the session is gone (signed out elsewhere, expired, account switched off). */
export const setUnauthorizedHandler = (fn) => (onUnauthorized = fn);

async function req(method, url, body) {
  // The server refuses writes without this header, which other websites can't add (see server/app.js).
  const init = { method, headers: { "X-Requested-With": "erp" } };
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
  if (res.status === 401 && !url.startsWith("/api/auth/")) onUnauthorized();
  if (!res.ok) {
    const e = new Error(data?.error || `Request failed (${res.status})`);
    e.status = res.status;
    throw e;
  }
  return data;
}

const enc = encodeURIComponent;

export const api = {
  authStatus: () => req("GET", "/api/auth/status"),
  setup: (b) => req("POST", "/api/auth/setup", b),
  login: (username, password) => req("POST", "/api/auth/login", { username, password }),
  logout: () => req("POST", "/api/auth/logout"),
  me: () => req("GET", "/api/me"),
  changePassword: (current, password) => req("PUT", "/api/me/password", { current, password }),
  users: () => req("GET", "/api/users"),
  createUser: (u) => req("POST", "/api/users", u),
  updateUser: (id, u) => req("PUT", `/api/users/${enc(id)}`, u),
  poAddLine: (itemKey, qty, supplierId) => req("POST", "/api/pos/add-line", { itemKey, qty, supplierId }),
  poCreate: (supplierId) => req("POST", "/api/pos", { supplierId }),
  poSave: (id, b) => req("PUT", `/api/pos/${enc(id)}`, b),
  poDelete: (id) => req("DELETE", `/api/pos/${enc(id)}`),
  poSend: (id, via) => req("POST", `/api/pos/${enc(id)}/send`, { via }),
  poReceive: (id, lines) => req("POST", `/api/pos/${enc(id)}/receive`, { lines }),
  poClose: (id) => req("POST", `/api/pos/${enc(id)}/close`),
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
  setItemSupplier: (key, supplierId) => req("PUT", `/api/items/${enc(key)}/supplier`, { supplierId }),
  createSupplier: (sp) => req("POST", "/api/suppliers", sp),
  updateSupplier: (id, sp) => req("PUT", `/api/suppliers/${enc(id)}`, sp),
  deleteSupplier: (id) => req("DELETE", `/api/suppliers/${enc(id)}`),
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
  const es = new EventSource("/api/events", { withCredentials: true });
  es.addEventListener("change", onChange);
  es.onopen = () => onStatus("live");
  es.onerror = () => onStatus("reconnecting");
  return es;
}
