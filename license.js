// Pro licence: activation against the FileFit licence server, cached locally.
import { CONFIG } from "./config.js";

const KEY = "filefit.licence";
const RECHECK = 3 * 86400e3;          // re-validate every 3 days
const OFFLINE_GRACE = 14 * 86400e3;   // keep Pro working offline for 2 weeks after the last good check

const hasChrome = !!(globalThis.chrome && chrome.storage && chrome.storage.local);

async function load(k) {
  if (hasChrome) return (await chrome.storage.local.get(k))[k];
  try { return JSON.parse(localStorage.getItem(k)); } catch { return undefined; }
}
async function save(k, v) {
  if (hasChrome) return v === undefined ? chrome.storage.local.remove(k) : chrome.storage.local.set({ [k]: v });
  try { v === undefined ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch {}
}

export async function deviceId() {
  let id = await load("filefit.device");
  if (!id) { id = crypto.randomUUID(); await save("filefit.device", id); }
  return id;
}

async function api(path, body) {
  if (!CONFIG.API_BASE) throw new Error("Pro activation is not available yet.");
  let res;
  try {
    res = await fetch(CONFIG.API_BASE + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    const e = new Error("Could not reach the FileFit server. Check your internet connection.");
    e.offline = true;
    throw e;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Server error " + res.status);
  return data;
}

/** Current licence state: { active, plan, expires, key, email } (never throws). */
export async function status({ refresh = false } = {}) {
  const lic = await load(KEY);
  if (!lic) return { active: false };
  const now = Date.now();
  const expired = lic.expires && lic.expires * 1000 < now;
  if (!refresh && !expired && now - lic.checkedAt < RECHECK) return lic;
  try {
    const fresh = await api("v1/check", { key: lic.key, device: await deviceId() });
    const next = { ...fresh, key: lic.key, checkedAt: now };
    await save(KEY, next);
    return next;
  } catch (e) {
    if (e.offline && now - lic.checkedAt < OFFLINE_GRACE && !expired) return lic;
    return { ...lic, active: false, error: e.message };
  }
}

export async function activate({ key, email, order }) {
  const body = { device: await deviceId() };
  if (key) body.key = key.trim();
  else { body.email = (email || "").trim(); body.order = (order || "").trim(); }
  const r = await api("v1/activate", body);
  const lic = { ...r, checkedAt: Date.now() };
  await save(KEY, lic);
  return lic;
}

export async function deactivate() {
  const lic = await load(KEY);
  if (lic) { try { await api("v1/deactivate", { key: lic.key, device: await deviceId() }); } catch {} }
  await save(KEY, undefined);
}
