import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Socket } from "node:net";
import { captureSessions } from "./session-capture.js";
import { parseSessionsArgs } from "./session-cli.js";
import type { SessionFilters } from "./session-inventory.js";

export const DASHBOARD_LIMITS = { sockets: 16, headerBytes: 8192, headerMs: 2000, overallMs: 15_000, responseBytes: 32 * 1024 * 1024 } as const;
export interface DashboardAssets { html: string; script: string; css: string }
export interface DashboardServerOptions {
  /** Zero is test-only; the CLI requires an explicit port from 1 through 65535. */
  port: number;
  capture?: typeof captureSessions;
  assets?: DashboardAssets;
  /** Test seams can shorten, never extend production deadlines. */
  deadlines?: { headerMs?: number; overallMs?: number };
}
export function parseDashboardQuery(raw: string): (SessionFilters & { all: boolean }) | null {
  const params = new URLSearchParams(raw), args: string[] = [], seen = new Set<string>();
  for (const [key, value] of params) {
    if (seen.has(key)) return null; seen.add(key);
    if (key === "all" && ["true", "false"].includes(value)) { if (value === "true") args.push("--all"); }
    else if (["deployment", "ticket", "repo"].includes(key)) args.push(`--${key}`, value);
    else return null;
  }
  const parsed = parseSessionsArgs(args);
  if (!parsed || parsed === "help") return null;
  const { json: _json, ...filters } = parsed;
  return filters;
}
function headers(request: IncomingMessage, key: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < request.rawHeaders.length; i += 2) if (request.rawHeaders[i]!.toLowerCase() === key) values.push(request.rawHeaders[i + 1]!);
  return values;
}
function deadline(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum;
  if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error("Invalid dashboard deadline");
  return value;
}
const SECURITY_HEADERS = {
  "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY", "Cross-Origin-Resource-Policy": "same-origin",
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};
/** Dedicated transport, not the Agent API. The only effect is an explicit local listener.
 * Trusts local OS processes; browser-origin guards are not user authentication. */
export async function startSessionDashboard(options: DashboardServerOptions): Promise<Server> {
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error("Invalid dashboard port");
  const headerMs = deadline(options.deadlines?.headerMs, DASHBOARD_LIMITS.headerMs);
  const overallMs = deadline(options.deadlines?.overallMs, DASHBOARD_LIMITS.overallMs);
  const capture = options.capture ?? captureSessions;
  const assets = options.assets ?? { html: "<!doctype html><html lang=\"en\"><title>PPA sessions</title><p>Dashboard page unavailable.</p></html>", script: "", css: "" };
  const sockets = new Set<Socket>();
  let active = false;
  const server = createServer({ maxHeaderSize: DASHBOARD_LIMITS.headerBytes, headersTimeout: headerMs, requestTimeout: headerMs, keepAliveTimeout: 1 });
  server.maxHeadersCount = 0;
  server.maxRequestsPerSocket = 1;
  server.on("connection", socket => {
    if (sockets.size >= DASHBOARD_LIMITS.sockets) { socket.destroy(); return; }
    sockets.add(socket);
    const timer = setTimeout(() => socket.destroy(), overallMs);
    const headerTimer = setTimeout(() => socket.destroy(), headerMs);
    // Each connection admits one request. Even a dribbling peer has an absolute deadline.
    socket.once("dashboard-request", () => clearTimeout(headerTimer));
    socket.on("error", () => socket.destroy());
    socket.once("close", () => { clearTimeout(timer); clearTimeout(headerTimer); sockets.delete(socket); });
  });
  server.on("request", (request, response) => {
    request.socket.emit("dashboard-request");
    request.on("error", () => request.socket.destroy());
    response.on("error", () => request.socket.destroy());
    const send = (status: number, body: string, type = "application/json; charset=utf-8") => {
      if (response.destroyed || response.headersSent) return;
      response.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": type, "Content-Length": Buffer.byteLength(body), Connection: "close" });
      response.end(body);
    };
    const reject = (status: number, code: string) => send(status, JSON.stringify({ error: code }));
    const address = server.address();
    if (!address || typeof address === "string") { reject(503, "unavailable"); return; }
    const host = `127.0.0.1:${address.port}`, origin = `http://${host}`;
    const exact = (key: string, value: string) => { const list = headers(request, key); return list.length === 1 && list[0] === value; };
    if (!exact("host", host)) { reject(400, "host"); return; }
    if ((headers(request, "origin").length && !exact("origin", origin))
      || (headers(request, "sec-fetch-site").length && !["same-origin", "none"].some(value => exact("sec-fetch-site", value)))) { reject(403, "origin"); return; }
    if (["authorization", "proxy-authorization", "cookie", "transfer-encoding", "trailer", "expect", "upgrade", "content-encoding"].some(key => headers(request, key).length)
      || (headers(request, "content-length").length && !exact("content-length", "0"))) { reject(400, "headers"); return; }
    if (request.method !== "GET") { reject(405, "method"); return; }
    const raw = request.url ?? "";
    if (raw.length > 1024 || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("#")) { reject(400, "route"); return; }
    const split = raw.indexOf("?"), path = split === -1 ? raw : raw.slice(0, split);
    if (path !== "/v1/sessions") {
      if (split !== -1) { reject(404, "route"); return; }
      if (path === "/") send(200, assets.html, "text/html; charset=utf-8");
      else if (path === "/dashboard.js") send(200, assets.script, "text/javascript; charset=utf-8");
      else if (path === "/dashboard.css") send(200, assets.css, "text/css; charset=utf-8");
      else reject(404, "route");
      return;
    }
    if (!exact("x-ppa-sessions", "1")) { reject(403, "request-header"); return; }
    const filters = parseDashboardQuery(split === -1 ? "" : raw.slice(split + 1));
    if (!filters) { reject(400, "filters"); return; }
    if (active) { reject(503, "busy"); return; }
    active = true;
    void (async () => {
      try {
        const snapshot = await capture(filters);
        if (response.destroyed || request.socket.destroyed) return;
        const body = JSON.stringify(snapshot);
        if (Buffer.byteLength(body) > DASHBOARD_LIMITS.responseBytes) { reject(503, "response-limit"); return; }
        send(200, body);
      } catch { reject(503, "capture-unavailable"); }
      finally { active = false; }
    })();
  });
  // Never route upgrade, CONNECT, Expect or malformed HTTP into collection.
  server.on("upgrade", (_request, socket) => socket.destroy());
  server.on("connect", (_request, socket) => socket.destroy());
  server.on("checkContinue", (_request, response) => { response.writeHead(417, { ...SECURITY_HEADERS, Connection: "close" }); response.end(); });
  server.on("checkExpectation", (_request, response) => { response.writeHead(417, { ...SECURITY_HEADERS, Connection: "close" }); response.end(); });
  server.on("clientError", (_error, socket) => socket.destroy());
  try {
    await new Promise<void>((resolve, reject) => {
      const fail = () => { server.off("listening", ready); reject(new Error("Dashboard listener unavailable")); };
      const ready = () => { server.off("error", fail); resolve(); };
      server.once("error", fail); server.once("listening", ready);
      server.listen({ host: "127.0.0.1", port: options.port, backlog: DASHBOARD_LIMITS.sockets });
    });
  } catch { server.close(); throw new Error("Dashboard listener unavailable"); }
  return server;
}
