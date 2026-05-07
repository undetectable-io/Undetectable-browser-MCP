#!/usr/bin/env node
/**
 * undetectable-local-api — MCP server (TypeScript) wrapping the Undetectable
 * Browser Local API (v1.5).
 *
 * Async / parallel-capable. All tools use native fetch with AbortController
 * timeout. Multiple in-flight tool calls run concurrently against the
 * Undetectable HTTP API instead of being serialized.
 *
 * Default base URL: http://127.0.0.1:25325 (override via UNDETECTABLE_BASE_URL).
 * Request timeout:  UNDETECTABLE_TIMEOUT seconds (default 60).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE_URL = (process.env.UNDETECTABLE_BASE_URL ?? "http://127.0.0.1:25325").replace(/\/$/, "");
const TIMEOUT = Number(process.env.UNDETECTABLE_TIMEOUT ?? "60");

// ---------- HTTP helpers ----------

async function _get(path: string, params?: Record<string, string>): Promise<unknown> {
  const url = new URL(BASE_URL + path);
  if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT * 1000);
  try {
    const r = await fetch(url, { headers: { Accept: "application/json" }, signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
    const text = await r.text();
    try { return JSON.parse(text); } catch { return { raw: text }; }
  } finally {
    clearTimeout(timer);
  }
}

async function _post(path: string, body?: Record<string, unknown>): Promise<unknown> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT * 1000);
  try {
    const r = await fetch(BASE_URL + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body ?? {}),
      signal: ctl.signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
    const text = await r.text();
    try { return JSON.parse(text); } catch { return { raw: text }; }
  } finally {
    clearTimeout(timer);
  }
}

async function _safe<T>(p: Promise<T>): Promise<T | { error: string; type: string }> {
  try {
    return await p;
  } catch (e) {
    const err = e as Error;
    return { error: err.message, type: err.name };
  }
}

function reply(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

// Strip undefined fields (so we send only what the caller provided)
function clean<T extends Record<string, unknown>>(o: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as Partial<T>;
}

// Some MCP clients stringify array arguments into a JSON string before
// sending them. This preprocess accepts either a real array or its JSON
// representation and feeds the array through the inner schema.
function arrayOrJsonString<T extends z.ZodTypeAny>(item: T) {
  return z.preprocess((v) => {
    if (typeof v !== "string") return v;
    try {
      const parsed = JSON.parse(v);
      return parsed;
    } catch {
      return v;
    }
  }, z.array(item));
}

// ---------- Allowed values (mirror the Undetectable program's pickers) ----------
//
// All create_profile fields are optional — when omitted, the program picks a
// random fingerprint config matching whatever combination of OS / browser /
// resolution / cpu / memory is supplied (OS takes priority). To pin a specific
// fingerprint, pass `configid` (see list_configs).

const OS_VALUES = [
  "Windows", "Windows 7", "Windows 8", "Windows 8.1", "Windows 10",
  "Android", "iPhone", "iPad", "Linux", "Mac",
] as const;

const BROWSER_VALUES = [
  "Chrome", "Edge", "FireFox", "IE", "Opera", "Safari", "Yandex",
] as const;

const PROFILE_TYPE_VALUES = ["cloud", "local"] as const;

const PROXY_TYPE_VALUES = ["http", "https", "socks5"] as const;

const RESOLUTION_VALUES = [
  "800x600", "960x540", "1024x768", "1152x864", "1280x720", "1280x768",
  "1280x800", "1280x1024", "1366x768", "1408x792", "1440x900", "1400x1050",
  "1440x1080", "1536x864", "1600x900", "1600x1024", "1600x1200", "1680x1050",
  "1920x1080", "1920x1200", "2048x1152", "2560x1080", "2560x1440", "3440x1440",
  "3840x2160", "5120x1440",
] as const;

const CPU_VALUES = [32, 24, 20, 16, 12, 10, 8, 7, 6, 5, 4, 3, 2, 1, 0] as const;
const MEMORY_VALUES = [32, 16, 8, 4, 2, 1, 0] as const;

// Helper: union of numeric literals (z.enum is string-only).
const numLiteralUnion = <T extends readonly [number, ...number[]]>(values: T) =>
  z.union(values.map((v) => z.literal(v)) as unknown as
    [z.ZodLiteral<T[number]>, z.ZodLiteral<T[number]>, ...z.ZodLiteral<T[number]>[]]);

// ---------- Server ----------

const server = new McpServer({ name: "undetectable-local-api-ts", version: "1.0.0" });

// ===== Local server =====

server.tool(
  "status",
  "Check whether the Undetectable local API server is running. GET /status.",
  {},
  async () => reply(await _get("/status")),
);

server.tool(
  "close_software",
  "Fully close the Undetectable desktop software. GET /close.",
  {},
  async () => reply(await _get("/close")),
);

// ===== Profiles =====
//
// IMPORTANT — profile state requirements:
//   Mutation/inspection endpoints below (update_profile, clear_profile_cache,
//   clear_profile_cookies, clear_profile_data, get_profile_cookies,
//   update_browser_version) REQUIRE the profile to be STOPPED. Running profiles
//   return errors like "Profile is started", "Profile is not available!" or
//   "Unable to init cookies storage". Call stop_profile first if needed.
//
// Proxy convention:
//   To create or update a profile WITHOUT a proxy (or to remove an existing
//   proxy from a profile), pass proxy="none" in create_profile / update_profile.
//

server.tool(
  "list_profiles",
  "Return the list of profiles in the program (Chromium). GET /list.",
  {},
  async () => reply(await _get("/list")),
);

server.tool(
  "get_profile_info",
  "Full info about a profile by ID. GET /profile/getinfo/{id}.",
  { profile_id: z.string() },
  async ({ profile_id }) => reply(await _get(`/profile/getinfo/${profile_id}`)),
);

server.tool(
  "start_profile",
  "Start (launch) a profile. GET /profile/start/{id}. Optional start_pages and chrome_flags.",
  {
    profile_id: z.string(),
    start_pages: z.array(z.string()).optional(),
    chrome_flags: z.string().optional(),
  },
  async ({ profile_id, start_pages, chrome_flags }) => {
    const params: Record<string, string> = {};
    if (start_pages?.length) params["start-pages"] = start_pages.join(",");
    if (chrome_flags) params.chrome_flags = chrome_flags;
    return reply(await _get(`/profile/start/${profile_id}`, Object.keys(params).length ? params : undefined));
  },
);

server.tool(
  "stop_profile",
  "Stop (close) a running profile by ID. GET /profile/stop/{id}.",
  { profile_id: z.string() },
  async ({ profile_id }) => reply(await _get(`/profile/stop/${profile_id}`)),
);

server.tool(
  "create_profile",
  'Create a new profile. POST /profile/create. ALL fields optional — omitted fields fall back to the Undetectable program defaults. The program picks a random fingerprint config matching whatever combination of os_name / browser / resolution / cpu / memory you supply (os_name takes priority; passing only os_name picks any browser for that OS). For an exact fingerprint pass `configid` (see list_configs). To create profile without proxy pass proxy="none".',
  {
    name: z.string().optional(),
    os_name: z.enum(OS_VALUES).optional(),
    browser: z.enum(BROWSER_VALUES).optional(),
    cpu: numLiteralUnion(CPU_VALUES).optional(),
    memory: numLiteralUnion(MEMORY_VALUES).optional(),
    tags: arrayOrJsonString(z.string()).optional(),
    geolocation: z.string().optional(),
    resolution: z.enum(RESOLUTION_VALUES).optional(),
    proxy: z.string().optional(),
    notes: z.string().optional(),
    folder: z.string().optional(),
    language: z.string().optional(),
    cookies: arrayOrJsonString(z.record(z.unknown())).optional(),
    type_: z.enum(PROFILE_TYPE_VALUES).optional(),
    group: z.string().optional(),
    configid: z.string().optional(),
    accounts: arrayOrJsonString(z.record(z.unknown())).optional(),
    timezone: z.string().optional(),
    webrtc: z.string().optional(),
    auto_allow_geo: z.boolean().optional(),
    extra: z.record(z.unknown()).optional(),
  },
  async (args) => {
    const body: Record<string, unknown> = clean({
      name: args.name,
      os: args.os_name,
      browser: args.browser,
      cpu: args.cpu,
      memory: args.memory,
      tags: args.tags,
      geolocation: args.geolocation,
      resolution: args.resolution,
      proxy: args.proxy,
      notes: args.notes,
      folder: args.folder,
      language: args.language,
      cookies: args.cookies,
      type: args.type_,
      group: args.group,
      configid: args.configid,
      accounts: args.accounts,
      timezone: args.timezone,
      webrtc: args.webrtc,
      auto_allow_geo: args.auto_allow_geo,
    });
    if (args.extra) Object.assign(body, args.extra);
    return reply(await _post("/profile/create", body));
  },
);

server.tool(
  "update_profile",
  'Update fields on an existing profile. POST /profile/update/{id}. All fields optional. REQUIRES profile to be STOPPED — fails with "Profile is started" if running. To remove proxy from profile pass proxy="none".',
  {
    profile_id: z.string(),
    name: z.string().optional(),
    tags: arrayOrJsonString(z.string()).optional(),
    geolocation: z.string().optional(),
    proxy: z.string().optional(),
    notes: z.string().optional(),
    folder: z.string().optional(),
    cookies: arrayOrJsonString(z.record(z.unknown())).optional(),
    type_: z.enum(PROFILE_TYPE_VALUES).optional(),
    group: z.string().optional(),
    accounts: arrayOrJsonString(z.record(z.unknown())).optional(),
    timezone: z.string().optional(),
    extra: z.record(z.unknown()).optional(),
  },
  async (args) => {
    const body: Record<string, unknown> = clean({
      name: args.name,
      tags: args.tags,
      geolocation: args.geolocation,
      proxy: args.proxy,
      notes: args.notes,
      folder: args.folder,
      cookies: args.cookies,
      type: args.type_,
      group: args.group,
      accounts: args.accounts,
      timezone: args.timezone,
    });
    if (args.extra) Object.assign(body, args.extra);
    return reply(await _post(`/profile/update/${args.profile_id}`, body));
  },
);

server.tool(
  "delete_profile",
  "Delete a profile by ID. GET /profile/delete/{id}.",
  { profile_id: z.string() },
  async ({ profile_id }) => reply(await _get(`/profile/delete/${profile_id}`)),
);

server.tool(
  "check_profile_connection",
  "Check network connectivity (proxy) for a profile. GET /profile/checkconnection/{id}.",
  { profile_id: z.string() },
  async ({ profile_id }) => reply(await _get(`/profile/checkconnection/${profile_id}`)),
);

server.tool(
  "send_profiles_to_cloud",
  "Send local profiles to cloud under a group. POST /profile/tocloud.",
  { group: z.string(), profiles: z.array(z.string()) },
  async ({ group, profiles }) => reply(await _post("/profile/tocloud", { group, profiles })),
);

server.tool(
  "make_profiles_local",
  "Convert cloud profiles to local. POST /profile/tolocal.",
  { profiles: z.array(z.string()) },
  async ({ profiles }) => reply(await _post("/profile/tolocal", { profiles })),
);

server.tool(
  "update_browser_version",
  "Update Chromium kernel of profile to latest. GET /profile/updatebrowser/{id}. Profile should be STOPPED before updating kernel.",
  { profile_id: z.string() },
  async ({ profile_id }) => reply(await _get(`/profile/updatebrowser/${profile_id}`)),
);

server.tool(
  "clear_profile_cache",
  'Clear only cache (keeps cookies/history/notes). GET /profile/clearcache/{id}. REQUIRES profile to be STOPPED — fails with "Profile is not available!" if running.',
  { profile_id: z.string() },
  async ({ profile_id }) => reply(await _get(`/profile/clearcache/${profile_id}`)),
);

server.tool(
  "clear_profile_data",
  'Clear ALL data of a profile. GET /profile/cleardata/{id}. REQUIRES profile to be STOPPED — fails with "Profile is not available!" if running.',
  { profile_id: z.string() },
  async ({ profile_id }) => reply(await _get(`/profile/cleardata/${profile_id}`)),
);

server.tool(
  "import_profiles",
  "Import profiles from a file or folder. POST /profile/import. Provide path OR dir.",
  { path: z.string().optional(), dir: z.string().optional() },
  async ({ path, dir }) => reply(await _post("/profile/import", clean({ path, dir }) as Record<string, unknown>)),
);

server.tool(
  "export_profiles",
  "Export profiles to a local folder. POST /profile/export.",
  { profiles: z.array(z.string()), dir: z.string() },
  async ({ profiles, dir }) => reply(await _post("/profile/export", { profiles, dir })),
);

// ===== Cookies =====

server.tool(
  "get_profile_cookies",
  'Get cookies for a profile. GET /profile/cookies/{id}. REQUIRES profile to be STOPPED — fails with "Unable to init cookies storage" if running.',
  { profile_id: z.string() },
  async ({ profile_id }) => reply(await _get(`/profile/cookies/${profile_id}`)),
);

server.tool(
  "clear_profile_cookies",
  'Clear ONLY cookies. GET /profile/clearcookies/{id}. REQUIRES profile to be STOPPED — fails with "Profile is not available!" if running.',
  { profile_id: z.string() },
  async ({ profile_id }) => reply(await _get(`/profile/clearcookies/${profile_id}`)),
);

// ===== Proxies =====

server.tool(
  "list_proxies",
  "Return list of proxies from Proxy Manager. GET /proxies/list.",
  {},
  async () => reply(await _get("/proxies/list")),
);

server.tool(
  "add_proxy",
  "Add a proxy. POST /proxies/add. Port accepts string or number.",
  {
    name: z.string(),
    type: z.enum(PROXY_TYPE_VALUES),
    host: z.string(),
    port: z.union([z.string(), z.number()]),
    login: z.string().optional(),
    password: z.string().optional(),
    ipchangelink: z.string().optional(),
  },
  async ({ name, type, host, port, login, password, ipchangelink }) =>
    reply(await _post("/proxies/add", {
      name,
      type,
      host,
      port: String(port),
      login: login ?? "",
      password: password ?? "",
      ipchangelink: ipchangelink ?? "",
    })),
);

server.tool(
  "delete_proxy",
  "Delete a proxy by ID. GET /proxies/delete/{id}.",
  { proxy_id: z.string() },
  async ({ proxy_id }) => reply(await _get(`/proxies/delete/${proxy_id}`)),
);

server.tool(
  "update_proxy",
  "Update a proxy by ID. POST /proxies/update/{id}. Port accepts string or number.",
  {
    proxy_id: z.string(),
    name: z.string().optional(),
    type: z.enum(PROXY_TYPE_VALUES).optional(),
    host: z.string().optional(),
    port: z.union([z.string(), z.number()]).optional(),
    login: z.string().optional(),
    password: z.string().optional(),
    ipchangelink: z.string().optional(),
    extra: z.record(z.unknown()).optional(),
  },
  async (args) => {
    const body: Record<string, unknown> = clean({
      name: args.name,
      type: args.type,
      host: args.host,
      port: args.port !== undefined ? String(args.port) : undefined,
      login: args.login,
      password: args.password,
      ipchangelink: args.ipchangelink,
    });
    if (args.extra) Object.assign(body, args.extra);
    return reply(await _post(`/proxies/update/${args.proxy_id}`, body));
  },
);

// ===== Groups / Configs / Folders / Timezones =====

server.tool("list_groups",    "List cloud groups. GET /groupslist.",       {}, async () => reply(await _get("/groupslist")));
server.tool("list_configs",   "List fingerprint configs available to the program. GET /configslist. Each entry has a `configid` you can pass to create_profile to pin an exact fingerprint instead of letting the program pick a random one matching os_name/browser.", {}, async () => reply(await _get("/configslist")));
server.tool("list_folders",   "List profile folders. GET /folderslist.",   {}, async () => reply(await _get("/folderslist")));
server.tool("list_timezones", "List supported timezones. GET /timezoneslist.", {}, async () => reply(await _get("/timezoneslist")));

// ===== Browser automation (active tab) =====

server.tool(
  "browser_open_tab",
  "Open a new browser tab in the active profile session. GET /browser/opentab/{id}.",
  { profile_id: z.string() },
  async ({ profile_id }) => reply(await _get(`/browser/opentab/${profile_id}`)),
);

server.tool(
  "browser_open_url",
  "Navigate the active tab to a URL. POST /browser/openurl/{id}.",
  { profile_id: z.string(), url: z.string() },
  async ({ profile_id, url }) => reply(await _post(`/browser/openurl/${profile_id}`, { url })),
);

server.tool(
  "browser_click",
  "Click element matching selector on active tab. POST /browser/click/{id}. Selector accepts CSS or XPath.",
  { profile_id: z.string(), selector: z.string() },
  async ({ profile_id, selector }) => reply(await _post(`/browser/click/${profile_id}`, { selector })),
);

server.tool(
  "browser_fill",
  "Fill input element with text on active tab. POST /browser/fill/{id}.",
  { profile_id: z.string(), selector: z.string(), text: z.string() },
  async ({ profile_id, selector, text }) =>
    reply(await _post(`/browser/fill/${profile_id}`, { selector, text })),
);

server.tool(
  "browser_select_option",
  "Select option in <select> element on active tab. POST /browser/select/{id}.",
  { profile_id: z.string(), selector: z.string(), value: z.string() },
  async ({ profile_id, selector, value }) =>
    reply(await _post(`/browser/select/${profile_id}`, { selector, value })),
);

server.tool(
  "browser_scroll_to",
  "Scroll element into view on active tab. POST /browser/scroll/{id}.",
  { profile_id: z.string(), selector: z.string() },
  async ({ profile_id, selector }) =>
    reply(await _post(`/browser/scroll/${profile_id}`, { selector })),
);

server.tool(
  "browser_focus",
  "Focus element on active tab. POST /browser/focus/{id}.",
  { profile_id: z.string(), selector: z.string() },
  async ({ profile_id, selector }) =>
    reply(await _post(`/browser/focus/${profile_id}`, { selector })),
);

server.tool(
  "browser_press_key",
  "Press a keyboard key on element in active tab (e.g. Enter, Tab, Escape). POST /browser/press/{id}.",
  { profile_id: z.string(), selector: z.string(), key: z.string() },
  async ({ profile_id, selector, key }) =>
    reply(await _post(`/browser/press/${profile_id}`, { selector, key })),
);

server.tool(
  "browser_evaluate",
  "Run JavaScript in active page context and return result. POST /browser/evaluate/{id}.",
  { profile_id: z.string(), script: z.string() },
  async ({ profile_id, script }) =>
    reply(await _post(`/browser/evaluate/${profile_id}`, { script })),
);

server.tool(
  "browser_get_page_html",
  "Return HTML of the active page. GET /browser/getpage/{id}.",
  { profile_id: z.string() },
  async ({ profile_id }) => reply(await _get(`/browser/getpage/${profile_id}`)),
);

server.tool(
  "browser_screenshot",
  "Capture screenshot of active page to local folder. POST /browser/screenshot/{id}. fullpage defaults to false.",
  {
    profile_id: z.string(),
    path: z.string(),
    fullpage: z.boolean().optional(),
  },
  async ({ profile_id, path, fullpage }) =>
    reply(await _post(`/browser/screenshot/${profile_id}`, clean({ path, fullpage }) as Record<string, unknown>)),
);

// ===== Batch helpers — Promise.all fan-out =====

server.tool(
  "stop_profiles",
  "Stop multiple profiles concurrently. Per-item failures returned as {error,type}.",
  { profile_ids: z.array(z.string()) },
  async ({ profile_ids }) =>
    reply(await Promise.all(profile_ids.map((id) => _safe(_get(`/profile/stop/${id}`))))),
);

server.tool(
  "start_profiles",
  "Start multiple profiles concurrently with the same start_pages / chrome_flags.",
  {
    profile_ids: z.array(z.string()),
    start_pages: z.array(z.string()).optional(),
    chrome_flags: z.string().optional(),
  },
  async ({ profile_ids, start_pages, chrome_flags }) => {
    const params: Record<string, string> = {};
    if (start_pages?.length) params["start-pages"] = start_pages.join(",");
    if (chrome_flags) params.chrome_flags = chrome_flags;
    const p = Object.keys(params).length ? params : undefined;
    return reply(
      await Promise.all(profile_ids.map((id) => _safe(_get(`/profile/start/${id}`, p)))),
    );
  },
);

server.tool(
  "delete_profiles",
  "Delete multiple profiles concurrently.",
  { profile_ids: z.array(z.string()) },
  async ({ profile_ids }) =>
    reply(await Promise.all(profile_ids.map((id) => _safe(_get(`/profile/delete/${id}`))))),
);

server.tool(
  "clear_profile_cookies_batch",
  "Clear cookies on multiple profiles concurrently. Each profile must be STOPPED — running profiles return per-item error.",
  { profile_ids: z.array(z.string()) },
  async ({ profile_ids }) =>
    reply(await Promise.all(profile_ids.map((id) => _safe(_get(`/profile/clearcookies/${id}`))))),
);

server.tool(
  "clear_profile_cache_batch",
  "Clear cache on multiple profiles concurrently. Each profile must be STOPPED — running profiles return per-item error.",
  { profile_ids: z.array(z.string()) },
  async ({ profile_ids }) =>
    reply(await Promise.all(profile_ids.map((id) => _safe(_get(`/profile/clearcache/${id}`))))),
);

server.tool(
  "get_profile_info_batch",
  "Fetch info for multiple profiles concurrently.",
  { profile_ids: z.array(z.string()) },
  async ({ profile_ids }) =>
    reply(await Promise.all(profile_ids.map((id) => _safe(_get(`/profile/getinfo/${id}`))))),
);

server.tool(
  "update_profiles_batch",
  'Update multiple profiles concurrently with per-profile bodies. Each item: {profile_id, body:{...}}. Each profile must be STOPPED — running profiles return per-item error. To remove proxy from a profile pass body.proxy="none".',
  {
    updates: z.array(z.object({
      profile_id: z.string(),
      body: z.record(z.unknown()).optional(),
    })),
  },
  async ({ updates }) =>
    reply(await Promise.all(
      updates.map((u) => _safe(_post(`/profile/update/${u.profile_id}`, u.body ?? {}))),
    )),
);

// ===== Escape hatch =====

server.tool(
  "raw_request",
  "Call any Undetectable endpoint directly. method=GET|POST, path starts with /.",
  {
    method: z.string(),
    path: z.string(),
    params: z.record(z.string()).optional(),
    json_body: z.record(z.unknown()).optional(),
  },
  async ({ method, path, params, json_body }) => {
    const m = method.toUpperCase();
    if (m === "GET") return reply(await _get(path, params));
    if (m === "POST") {
      // raw_request POST also supports query params via params; combine into URL
      if (params) {
        const url = new URL(BASE_URL + path);
        for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), TIMEOUT * 1000);
        try {
          const r = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify(json_body ?? {}),
            signal: ctl.signal,
          });
          if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
          const text = await r.text();
          try { return reply(JSON.parse(text)); } catch { return reply({ raw: text }); }
        } finally {
          clearTimeout(timer);
        }
      }
      return reply(await _post(path, json_body));
    }
    throw new Error(`Unsupported HTTP method: ${method}`);
  },
);

// ---------- main ----------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Server fatal error:", err);
  process.exit(1);
});
