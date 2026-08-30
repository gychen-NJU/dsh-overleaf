import { Service } from "@deepseek-ai/cordis";
import http from "node:http";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import z from "@deepseek-ai/schemastery";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import net, { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import https from "node:https";
import { connect } from "node:tls";
//#region lib/types/config.js
/**
* Host plugin configuration schema. Every field is deployment-overridable from
* the profile row (cordis.patch.yml / plugin settings page); credentials never
* appear here.
*/
/** Default upstream: the public Overleaf cloud (user decision, v0.1.3). */
const DEFAULT_BASE_URL = "https://www.overleaf.com";
const DEFAULT_LOGIN_TIMEOUT_MS = 6e5;
const Config = z.object({
	baseUrl: z.string().default(DEFAULT_BASE_URL),
	browserChannel: z.union([
		z.const("auto"),
		z.const("default"),
		z.const("msedge"),
		z.const("chrome"),
		z.const("real")
	]).default("auto"),
	browserPath: z.string(),
	loginProxyServer: z.string(),
	loginTimeoutMs: z.natural().default(DEFAULT_LOGIN_TIMEOUT_MS),
	loginProfile: z.union([z.const("persistent"), z.const("temporary")]).default("persistent"),
	selectionQuoteEnabled: z.boolean().default(true),
	cursorInsertEnabled: z.boolean().default(true),
	injectScriptEnabled: z.boolean().default(true),
	assistPanelEnabled: z.boolean().default(true)
});
/** Apply defaults in the owning implementation, never hidden inside methods. */
function resolveConfig(config) {
	const channel = config.browserChannel ?? "auto";
	const browserPath = config.browserPath !== void 0 && config.browserPath.trim() !== "" ? config.browserPath.trim() : void 0;
	const loginProxyServer = config.loginProxyServer !== void 0 && config.loginProxyServer.trim() !== "" ? normalizeProxyServer(config.loginProxyServer) : void 0;
	return {
		baseUrl: normalizeOrigin(config.baseUrl ?? DEFAULT_BASE_URL),
		browserChannel: channel,
		...browserPath !== void 0 ? { browserPath } : {},
		...loginProxyServer !== void 0 ? { loginProxyServer } : {},
		loginTimeoutMs: config.loginTimeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS,
		loginProfile: config.loginProfile ?? "persistent",
		selectionQuoteEnabled: config.selectionQuoteEnabled ?? true,
		cursorInsertEnabled: config.cursorInsertEnabled ?? true,
		injectScriptEnabled: config.injectScriptEnabled ?? true,
		assistPanelEnabled: config.assistPanelEnabled ?? true
	};
}
/**
* Normalize a user-supplied proxy server string into the form Chromium's
* --proxy-server flag accepts (mirrors the dsh-browser helper): a bare port
* becomes a loopback HTTP proxy, scheme-less host:port gains http://, and
* full scheme URLs pass through. Empty/invalid yields undefined so the flag
* is omitted entirely (system VPN / direct).
*/
function normalizeProxyServer(raw) {
	if (raw === void 0 || raw === "") return void 0;
	const trimmed = raw.trim();
	if (trimmed === "") return void 0;
	if (/^\d+$/.test(trimmed)) return `http://127.0.0.1:${trimmed}`;
	if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) return trimmed;
	return `http://${trimmed}`;
}
/**
* Normalize one configured origin: add https:// when scheme-less, trim
* trailing slashes, reject anything carrying a path/query/hash. Used instead
* of URL parsing failures to keep a bad entry from blocking service startup —
* falls back to the default upstream.
*/
function normalizeOrigin(raw) {
	let candidate = raw.trim();
	if (candidate === "") return DEFAULT_BASE_URL;
	if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(candidate)) candidate = `https://${candidate}`;
	try {
		const url = new URL(candidate);
		if (url.protocol !== "http:" && url.protocol !== "https:" || url.pathname.replace(/\/+$/, "") !== "" || url.search !== "" || url.hash !== "") return DEFAULT_BASE_URL;
		return url.origin;
	} catch {
		return DEFAULT_BASE_URL;
	}
}
//#endregion
//#region lib/types/credentials.js
/**
* Overleaf workbench credential references. Values never pass through plugin
* config or route responses; the host resolves and stores them through
* `ctx.credentials`. The ref name is deliberately namespaced away from
* dsh-better-overleaf's OVERLEAF_COOKIE so two Overleaf plugins never fight
* over one stored value.
*/
/**
* Session cookies captured by the direct-CDP login (also accepted from the
* manual-cookie route). Stored as one `Cookie:` header string
* (`name=value; name2=value2`) scoped to the configured baseUrl.
*/
const OVERLEAF_WORKBENCH_COOKIE = credentialRef("OVERLEAF_WORKBENCH_COOKIE");
//#endregion
//#region lib/types/cookie-validate.js
/**
* Cookie-header validation shared by the paste-cookie route and the CDP
* capture loop. Tolerant by design: the upstream may be standard Overleaf
* (where /project answers 200 when authenticated) or a TeXPage-based
* deployment whose dashboard lives at a different path, so any answer that is
* NOT an explicit bounce to a login page counts as authenticated.
*/
/** Cookie names that never indicate a real session. */
const PREFERENCE_COOKIES = /* @__PURE__ */ new Set([
	"lang",
	"locale",
	"language",
	"theme",
	"tz",
	"timezone",
	"acw_tc",
	"cdn_sec_tc"
]);
/** Whether one cookie plausibly carries a session. */
function isSessionishCookie(name, value) {
	const lower = name.toLowerCase();
	if (PREFERENCE_COOKIES.has(lower)) return false;
	if (lower.startsWith("csrf") || lower.endsWith("_csrf")) return false;
	return value.trim().length >= 8;
}
/** Whether a redirect Location points at a login/SSO surface. */
function locationLooksLikeLogin(location) {
	if (location === "") return false;
	return /(?:^|[/?.])(?:login|signin|sign-in|sign_in|signon|sign_on|sso|oauth|auth|cas|ids)(?:$|[/?#&])|login\.[a-z]/i.test(location);
}
/**
* Validate one Cookie header against the upstream. Accepted answers:
*  - 200 from /project (standard Overleaf authenticated),
*  - any 3xx whose Location is NOT a login/SSO page (dashboard redirect),
*  - 404 (route may not exist on this product; unverifiable here).
* Everything else — especially 3xx to /login — rejects.
*/
async function validateCookieHeader(cookie, baseUrl, timeoutMs = 15e3) {
	const response = await fetch(`${baseUrl}/project`, {
		headers: {
			cookie,
			accept: "text/html"
		},
		redirect: "manual",
		signal: AbortSignal.timeout(timeoutMs)
	});
	const location = response.headers.get("location") ?? "";
	if (response.status === 200 || response.status === 404) return;
	if (response.status >= 300 && response.status < 400 && !locationLooksLikeLogin(location)) return;
	throw new Error(`dsh-overleaf: cookie rejected by ${baseUrl} (HTTP ${response.status}${location === "" ? "" : ` -> ${location}`}); it must include the live session cookie value from the site's DevTools`);
}
//#endregion
//#region lib/types/login-cdp.js
/**
* Direct-CDP Overleaf login for dsh-overleaf. Launches a user-selected
* Chromium-family browser with a dedicated (persistent by default) profile and
* a freshly reserved loopback CDP port, waits for the user to log in on the
* configured upstream origin, then reads its cookies with the browser-level
* `Storage.getCookies` / `Network.getAllCookies` commands. No Playwright
* download and no ChromeDriver.
*
* Adapted for dsh-overleaf from Hoemr/dsh-better-overleaf (MIT), with the
* cookie-domain filter derived from the configured baseUrl instead of being
* hard-coded to overleaf.com.
*/
/** Stable dedicated profile directory for persistent login sessions. */
function persistentLoginProfileDir() {
	return join(homedir(), ".dsh", "plugin-data", "dsh-overleaf-workbench", "browser-profile");
}
/** Minimal promise-based CDP client over the Node global WebSocket. */
var CdpClient = class CdpClient {
	ws;
	nextId = 1;
	pending = /* @__PURE__ */ new Map();
	constructor(ws) {
		this.ws = ws;
		ws.onmessage = (event) => {
			const message = JSON.parse(String(event.data));
			const id = message.id;
			if (id === void 0) return;
			const pending = this.pending.get(id);
			if (pending === void 0) return;
			this.pending.delete(id);
			if (message.error !== void 0) pending.reject(new Error(message.error.message ?? "CDP error"));
			else pending.resolve(message.result);
		};
	}
	static async connect(url, timeoutMs = 5e3) {
		const ws = new WebSocket(url);
		await new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				ws.close();
				reject(/* @__PURE__ */ new Error(`dsh-overleaf: CDP WebSocket timed out for ${url}`));
			}, timeoutMs);
			ws.onopen = () => {
				clearTimeout(timer);
				resolve();
			};
			ws.onerror = () => {
				clearTimeout(timer);
				reject(/* @__PURE__ */ new Error(`dsh-overleaf: CDP WebSocket failed for ${url}`));
			};
		});
		return new CdpClient(ws);
	}
	call(method, params = {}, timeoutMs = 5e3) {
		const id = this.nextId;
		this.nextId += 1;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(/* @__PURE__ */ new Error(`dsh-overleaf: CDP ${method} timed out`));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (value) => {
					clearTimeout(timer);
					resolve(value);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				}
			});
			this.ws.send(JSON.stringify({
				id,
				method,
				params
			}));
		});
	}
	close() {
		try {
			this.ws.close();
		} catch {}
	}
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Locate the Windows default-browser executable through shell association. */
function windowsDefaultBrowserExecutable() {
	if (process.platform !== "win32") return void 0;
	const script = [
		"$ErrorActionPreference='SilentlyContinue';",
		"$prog=(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice').ProgId;",
		"if(-not $prog){$prog=(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice').ProgId};",
		"if(-not $prog){exit 1};",
		"$cmd=(Get-ItemProperty \"Registry::HKEY_CLASSES_ROOT\\$prog\\shell\\open\\command\").'(default)';",
		"if($cmd -match '^\"([^\"]+)\"'){$exe=$matches[1]}elseif($cmd -match '^\\S+'){$exe=$matches[0]};",
		"if($exe){[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($exe))}"
	].join(" ");
	const encoded = spawnSync("powershell.exe", [
		"-NoProfile",
		"-NonInteractive",
		"-Command",
		script
	], {
		encoding: "utf8",
		windowsHide: true
	}).stdout?.trim();
	if (encoded === void 0 || encoded === "") return void 0;
	const executable = Buffer.from(encoded, "base64").toString("utf8");
	if (executable === "" || !existsSync(executable)) return void 0;
	return executable;
}
/** Common Chromium-family executable paths across platforms. */
function commonChromiumExecutables() {
	const roots = [
		process.env.PROGRAMFILES,
		process.env["PROGRAMFILES(X86)"],
		process.env.LOCALAPPDATA,
		process.env.HOME,
		"/Applications",
		"/usr/bin"
	].filter((root) => root !== void 0);
	const names = process.platform === "win32" ? [
		"Microsoft\\Edge\\Application\\msedge.exe",
		"Google\\Chrome\\Application\\chrome.exe",
		"Chromium\\Application\\chrome.exe",
		"BraveSoftware\\Brave-Browser\\Application\\brave.exe",
		"Vivaldi\\Application\\vivaldi.exe"
	] : process.platform === "darwin" ? [
		"Google Chrome.app/Contents/MacOS/Google Chrome",
		"Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
		"Chromium.app/Contents/MacOS/Chromium",
		"Brave Browser.app/Contents/MacOS/Brave Browser"
	] : [
		"google-chrome",
		"chromium",
		"microsoft-edge",
		"brave-browser"
	];
	const candidates = [];
	for (const root of roots) for (const name of names) candidates.push(join(root, name));
	return candidates.filter((candidate) => existsSync(candidate) && !/firefox/i.test(candidate));
}
/** Build ordered launch candidates for one browser selection. */
function candidatesFor(channel, browserPath) {
	const candidates = [];
	if (browserPath !== void 0 && browserPath.trim() !== "" && existsSync(browserPath.trim())) candidates.push({
		label: browserPath.trim(),
		executablePath: browserPath.trim()
	});
	if (channel === "msedge") {
		const executablePath = commonChromiumExecutables().find((path) => /msedge/i.test(path));
		if (executablePath !== void 0) candidates.push({
			label: "Microsoft Edge",
			executablePath
		});
		return candidates;
	}
	if (channel === "chrome") {
		const executablePath = commonChromiumExecutables().find((path) => /chrome|chromium/i.test(path));
		if (executablePath !== void 0) candidates.push({
			label: "Chrome/Chromium",
			executablePath
		});
		return candidates;
	}
	const defaultBrowser = windowsDefaultBrowserExecutable();
	if (channel === "default") {
		if (defaultBrowser !== void 0) candidates.push({
			label: "Default browser",
			executablePath: defaultBrowser
		});
		return candidates;
	}
	if (channel === "real") {
		if (defaultBrowser !== void 0) candidates.push({
			label: "Default browser (real profile)",
			executablePath: defaultBrowser
		});
		for (const executablePath of commonChromiumExecutables()) if (!candidates.some((candidate) => candidate.executablePath === executablePath)) candidates.push({
			label: `${executablePath} (real profile)`,
			executablePath
		});
		return candidates;
	}
	if (defaultBrowser !== void 0) candidates.push({
		label: "Default browser",
		executablePath: defaultBrowser
	});
	for (const executablePath of commonChromiumExecutables()) if (!candidates.some((candidate) => candidate.executablePath === executablePath)) candidates.push({
		label: executablePath,
		executablePath
	});
	return candidates;
}
/** Reserve one loopback TCP port for the browser CDP endpoint. */
async function findFreeCdpPort() {
	const server = createServer();
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			resolve();
		});
	});
	const address = server.address();
	await new Promise((resolve, reject) => {
		server.close((error) => {
			if (error === void 0) resolve();
			else reject(error);
		});
	});
	const port = typeof address === "object" && address !== null ? address.port : void 0;
	if (port === void 0 || !Number.isInteger(port) || port <= 0) throw new Error("dsh-overleaf: could not reserve a local CDP port");
	return port;
}
/** Reject as soon as the launched browser process errors or exits. */
function browserProcessFailure(child) {
	return new Promise((_, reject) => {
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			reject(/* @__PURE__ */ new Error(`dsh-overleaf: browser exited before CDP was ready (code=${String(code)}, signal=${String(signal)})`));
		});
	});
}
/** Poll one local CDP endpoint until the browser has bound it. */
async function connectCdpWithRetry(port, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) try {
		return await connectCdp(port);
	} catch {
		await sleep(300);
	}
	throw new Error(`dsh-overleaf: browser did not expose CDP on 127.0.0.1:${port} within ${timeoutMs}ms`);
}
/** Connect to one browser-level CDP endpoint. */
async function connectCdp(port) {
	const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2e3) });
	if (!response.ok) throw new Error(`dsh-overleaf: CDP endpoint returned HTTP ${response.status} on 127.0.0.1:${port}`);
	const version = await response.json();
	if (version.webSocketDebuggerUrl === void 0) throw new Error("dsh-overleaf: CDP endpoint has no webSocketDebuggerUrl");
	return await CdpClient.connect(version.webSocketDebuggerUrl);
}
/** Read all cookies from one CDP connection via browser-level cookie APIs. */
async function readCookiesFrom(cdp) {
	let lastError;
	for (const method of ["Storage.getCookies", "Network.getAllCookies"]) try {
		const result = await cdp.call(method);
		if (!Array.isArray(result.cookies)) throw new Error(`dsh-overleaf: CDP ${method} returned no cookie array`);
		return result.cookies;
	} catch (error) {
		lastError = error;
	}
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
/** Connect to the first page target when the browser target lacks a cookie API. */
async function connectFirstPageCdp(port, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2e3) });
			if (!response.ok) throw new Error(`dsh-overleaf: CDP target list returned HTTP ${response.status}`);
			const pageUrl = (await response.json()).find((target) => target.type === "page")?.webSocketDebuggerUrl;
			if (pageUrl === void 0) throw new Error("dsh-overleaf: CDP target list has no page WebSocket");
			return await CdpClient.connect(pageUrl);
		} catch {}
		await sleep(300);
	}
	throw new Error(`dsh-overleaf: browser exposed no page CDP target on 127.0.0.1:${port} within ${timeoutMs}ms`);
}
/** List URLs of page targets currently exposed by the browser. */
async function pageTargetUrls(port) {
	const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2e3) });
	if (!response.ok) throw new Error(`dsh-overleaf: CDP target list returned HTTP ${response.status}`);
	return (await response.json()).filter((target) => target.type === "page" && typeof target.url === "string").map((target) => target.url);
}
/**
* Read target-origin cookies through CDP once the user has logged in.
*
* Detection is product-agnostic: the upstream may be standard Overleaf (where
* the session cookie is `overleaf_session2`) or a TeXPage-based deployment
* (self-hosted NJU and others) whose session cookie uses an entirely
* different name and whose dashboard may live at any path. Success therefore
* requires ALL of:
*  1. at least one non-preference cookie scoped to the target host,
*  2. a browser tab sitting on the target origin OUTSIDE its login/SSO pages,
*  3. server-side validation of the assembled header against /project
*     (tolerant: 200, 3xx-away-from-login, or 404 all count as authenticated).
*/
async function captureCookies(browserCdp, cdpPort, options, timeoutMs) {
	const bareHost = options.targetHost.replace(/^www\./, "");
	const origin = options.baseUrl.replace(/\/+$/, "");
	const deadline = Date.now() + timeoutMs;
	let cookieCdp = browserCdp;
	let pageCdp;
	try {
		while (Date.now() < deadline) {
			try {
				const siteCookies = (await readCookiesFrom(cookieCdp)).filter((cookie) => cookie.domain === bareHost || cookie.domain.endsWith(`.${bareHost}`));
				if (siteCookies.filter((cookie) => isSessionishCookie(cookie.name, cookie.value)).length > 0) {
					const header = siteCookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
					let onLoggedInPage = false;
					try {
						onLoggedInPage = (await pageTargetUrls(cdpPort)).some((url) => {
							if (!url.startsWith(`${origin}/`)) return false;
							return !locationLooksLikeLogin(url.slice(origin.length));
						});
					} catch {
						onLoggedInPage = false;
					}
					if (onLoggedInPage) try {
						await validateCookieHeader(header, options.baseUrl);
						return header;
					} catch {}
				}
			} catch (error) {
				pageCdp?.close();
				pageCdp = void 0;
				cookieCdp = browserCdp;
				const remaining = deadline - Date.now();
				if (remaining <= 0) throw error;
				pageCdp = await connectFirstPageCdp(cdpPort, Math.min(12e3, remaining));
				cookieCdp = pageCdp;
				continue;
			}
			await sleep(2e3);
		}
		throw new Error("dsh-overleaf: did not detect a logged-in session before timeout — complete the sign-in inside the opened browser window and keep it open until the workbench reports success");
	} finally {
		pageCdp?.close();
	}
}
/** Stop one browser process tree. */
function stopBrowser(child) {
	if (child.pid === void 0) return;
	if (process.platform === "win32") spawnSync("taskkill", [
		"/pid",
		String(child.pid),
		"/T",
		"/F"
	], {
		stdio: "ignore",
		windowsHide: true
	});
	else child.kill("SIGTERM");
}
/** Run one CDP login attempt against one browser executable. */
async function loginWithExecutable(executablePath, options) {
	const cdpPort = await findFreeCdpPort();
	const realProfile = options.browserChannel === "real";
	let tempProfileDir;
	let profileDir;
	if (realProfile) profileDir = "(real profile)";
	else if ((options.profileMode ?? "persistent") === "persistent") {
		profileDir = persistentLoginProfileDir();
		await mkdir(profileDir, { recursive: true });
	} else {
		profileDir = await mkdtemp(join(tmpdir(), "dsh-overleaf-workbench-cdp-"));
		tempProfileDir = profileDir;
	}
	const child = spawn(executablePath, [
		...realProfile ? [] : [`--user-data-dir=${profileDir}`],
		`--remote-debugging-port=${cdpPort}`,
		"--remote-debugging-address=127.0.0.1",
		"--remote-allow-origins=*",
		"--no-first-run",
		"--no-default-browser-check",
		...options.loginProxyServer !== void 0 && options.loginProxyServer !== "" ? [`--proxy-server=${options.loginProxyServer}`] : [],
		options.loginUrl
	], {
		stdio: "ignore",
		windowsHide: true
	});
	let cdp;
	try {
		cdp = await Promise.race([connectCdpWithRetry(cdpPort, 12e3), browserProcessFailure(child)]);
		const browserExited = new Promise((_, reject) => {
			child.once("exit", (code, signal) => {
				reject(/* @__PURE__ */ new Error(`dsh-overleaf: the login browser was closed before the session was captured (code=${String(code)}, signal=${String(signal)}); keep the window open until the workbench reports success, or paste the cookie manually`));
			});
		});
		return await Promise.race([captureCookies(cdp, cdpPort, options, options.timeoutMs), browserExited]);
	} catch (error) {
		if (realProfile) throw new Error(`${error instanceof Error ? error.message : String(error)} — real-profile mode needs the browser fully closed first (a running instance swallows the debug-port flag), and newer Chrome builds refuse CDP on the default profile`);
		throw error;
	} finally {
		cdp?.close();
		if (!realProfile) stopBrowser(child);
		if (tempProfileDir !== void 0) try {
			await rm(tempProfileDir, {
				recursive: true,
				force: true
			});
		} catch {}
	}
}
/** Open a URL in the computer's default browser. */
function openDefaultBrowser(url) {
	const command = process.platform === "win32" ? {
		file: "cmd.exe",
		args: [
			"/c",
			"start",
			"",
			url
		]
	} : process.platform === "darwin" ? {
		file: "open",
		args: [url]
	} : {
		file: "xdg-open",
		args: [url]
	};
	return new Promise((resolve, reject) => {
		const child = spawn(command.file, command.args, {
			stdio: "ignore",
			shell: process.platform === "win32"
		});
		child.once("error", reject);
		child.once("close", (code) => {
			if (code === 0) resolve();
			else reject(/* @__PURE__ */ new Error(`dsh-overleaf: default-browser launcher exited ${String(code)}`));
		});
	});
}
/**
* Run the CDP login flow. Returns automatic when cookies were captured,
* otherwise opens the default browser and returns manual-paste instructions.
* @param credentials - host credential service.
* @param options - login orchestration options.
*/
async function loginViaCdp(credentials, options) {
	const failures = [];
	for (const candidate of candidatesFor(options.browserChannel, options.browserPath)) try {
		const cookie = await loginWithExecutable(candidate.executablePath, options);
		await credentials.set(OVERLEAF_WORKBENCH_COOKIE, cookie);
		return { kind: "automatic" };
	} catch (error) {
		failures.push(`${candidate.label}: ${error instanceof Error ? error.message : String(error)}`);
	}
	await openDefaultBrowser(options.loginUrl).catch(() => void 0);
	return {
		kind: "manual",
		loginUrl: options.loginUrl,
		instructions: failures.length === 0 ? `Log in to ${options.targetHost} in your default browser, then copy the full Cookie request-header line (DevTools > Network > any request to ${options.targetHost} > Request Headers > Cookie; it must include the httpOnly session cookie such as overleaf_session2). Paste it through the workbench cookie dialog.` : `Automatic cookie capture failed for: ${failures.join(" | ")}. Log in in the opened browser, then copy the full Cookie request-header line from DevTools > Network (must include the httpOnly session cookie) and paste it through the workbench cookie dialog.`
	};
}
//#endregion
//#region lib/types/proxy.js
/**
* Same-origin reverse proxy for one fixed Overleaf origin. The embedded view
* loads `${PROXY_PREFIX}/<path>` instead of the real site, which sidesteps
* X-Frame-Options/CSP framing limits and (critically) makes the iframe
* same-origin with the GUI shell, enabling the selection and cursor bridges.
*
* Design notes:
* - Requests stream both ways without buffering (binary uploads/downloads,
*   compiled PDFs), EXCEPT text/html responses whose bodies need rebasing.
* - The target is locked to config.baseUrl (no SSRF surface): every outbound
*   connection goes to that single origin.
* - Loopback-only enforcement lives in the service route wrapper; handlers
*   here assume an already-fenced request.
*/
/** Prefix under which the upstream site is exposed (disjoint from other plugins). */
const PROXY_PREFIX = "/overleaf-proxy";
/** Proxied HTML responses larger than this stream through untouched. */
const MAX_REWRITE_BODY_BYTES = 4194304;
/** Upstream connection timeout for regular proxied requests. */
const REQUEST_TIMEOUT_MS = 6e4;
/** Compile is a synchronous long-poll and legitimately outlives asset calls. */
const COMPILE_REQUEST_TIMEOUT_MS = 6e5;
/** Timeout granted to establish the tunneled upstream TCP/TLS connection. */
const UPGRADE_CONNECT_TIMEOUT_MS = 1e4;
/** Hop-by-hop headers that must never cross a proxy hop. */
const HOP_BY_HOP = /* @__PURE__ */ new Set([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade"
]);
/** Rebase one root-relative reference against the proxy prefix. URLs already
*  carrying the prefix (double-rebase guard) or pointing at the plugin's own
*  routes are left untouched. */
function rebaseAttributeUrl(url, prefix) {
	if (!url.startsWith("/")) return url;
	if (url.startsWith(`${prefix}/`) || url.startsWith("/overleaf/workbench/")) return url;
	return `${prefix}${url}`;
}
/**
* Rebase CSS url(...) / @import references inside one stylesheet body.
* (text/css responses are otherwise passed through untouched - un-rebased
* `url(/overleaf-logo.svg)`-style references resolve against the shell origin
* and 404 in a loop.)
*/
function rewriteCss(css, prefix) {
	return css.replace(/url\(\s*(['"]?)(\/[^)'"]+)(['"]?)\s*\)/gi, (_match, quote, pathValue, tail) => `url(${quote}${rebaseAttributeUrl(pathValue, prefix)}${tail})`).replace(/(@import\s+)(?!url\()(["'])(\/[^"']+)\2/gi, (_match, lead, quote, pathValue) => `${lead}${quote}${rebaseAttributeUrl(pathValue, prefix)}${quote}`);
}
/**
* Extract the script nonce for one response: prefer the `script-src` nonce in
* the CSP header, fall back to the first `<script nonce="...">` in the HTML.
* Under `'strict-dynamic'` CSP, 'self'/host allowlists are ignored and ONLY
* nonce-marked scripts run, so the injected bridge must carry this nonce.
*/
function extractCspNonce(csp, html) {
	if (csp !== void 0 && csp !== "") {
		const scriptSrc = /script-src[^;]*/i.exec(csp)?.[0] ?? csp;
		const nonce = /'nonce-([^']+)'/.exec(scriptSrc)?.[1];
		if (nonce !== void 0 && nonce !== "") return nonce;
	}
	if (html !== void 0 && html !== "") {
		const nonce = /<script[^>]*\bnonce="([^"]+)"/i.exec(html)?.[1];
		if (nonce !== void 0 && nonce !== "") return nonce;
	}
}
/**
* Rewrite one HTML body for same-origin serving:
*  1. every occurrence of the TARGET ORIGIN string becomes the proxy prefix,
*     so apps that build internal links/API/socket URLs from an embedded
*     `siteUrl` (Overleaf does exactly this) stay inside the proxy instead of
*     navigating the iframe to the real site, where X-Frame-Options blocks
*     the load and clicks appear dead;
*  2. root-relative attribute references become proxy-rooted;
*  3. the bridge script (and via it the runtime URL wrappers) is injected,
*     carrying the response's CSP nonce when one exists ('strict-dynamic'
*     pages would otherwise block it).
*/
/** Rewrite root-relative resource references inside one HTML body. */
function rewriteHtml(html, prefix, injectScriptSrc, targetOrigin, cspNonce, wsPort) {
	let out = html.replaceAll("\"//", "\"https://");
	out = out.replace(/(\s(?:href|src|action|poster|data-src)\s*=\s*")(\/[^"']*)(")/gi, (_match, lead, pathValue, tail) => `${lead}${rebaseAttributeUrl(pathValue, prefix)}${tail}`);
	out = out.replace(/(srcset\s*=\s*")([^"]*)(")/gi, (_m, lead, value, tail) => {
		return `${lead}${value.split(",").map((part) => {
			const trimmed = part.trimStart();
			const leadingWhitespace = part.slice(0, part.length - trimmed.length);
			const [pathPart, descriptor] = trimmed.split(/\s+/, 2);
			const based = rebaseAttributeUrl(pathPart ?? "", prefix);
			return descriptor === void 0 ? `${leadingWhitespace}${based}` : `${leadingWhitespace}${based} ${descriptor}`;
		}).join(",")}${tail}`;
	});
	if (targetOrigin !== void 0 && targetOrigin !== "") out = out.split(targetOrigin).join(prefix);
	out = out.replace(/url\(\s*(['"]?)(\/[^)'"]+)(['"]?)\s*\)/gi, (_match, quote, pathValue, tail) => `url(${quote}${rebaseAttributeUrl(pathValue, prefix)}${tail})`);
	if (!/<base\s/i.test(out)) {
		const baseTag = `<base href="${prefix}/">`;
		if (/<head[^>]*>/i.test(out)) out = out.replace(/<head[^>]*>/i, (match) => `${match}\n${baseTag}\n`);
		else if (/<html[^>]*>/i.test(out)) out = out.replace(/<html[^>]*>/i, (match) => `${match}\n${baseTag}\n`);
		else out = `${baseTag}\n${out}`;
	}
	if (injectScriptSrc !== void 0 && !html.includes("dsh-overleaf-bridge")) {
		const nonceAttr = cspNonce !== void 0 && cspNonce !== "" ? ` nonce="${cspNonce}"` : "";
		const tag = `${wsPort > 0 ? `<script${nonceAttr}>window.__DSH_OVERLEAF_WS_PORT__=${wsPort};<\/script>\n` : ""}<script src="${injectScriptSrc}"${nonceAttr} data-dsh-overleaf-bridge><\/script>`;
		if (/<head[^>]*>/i.test(out)) out = out.replace(/<head[^>]*>/i, (match) => `${match}\n${tag}\n`);
		else if (/<html[^>]*>/i.test(out)) out = out.replace(/<html[^>]*>/i, (match) => `${match}\n${tag}\n`);
		else out = `${tag}\n${out}`;
	}
	return out;
}
/**
* Rewrite a Content-Security-Policy value so the proxied document can run:
*  1. drop `frame-ancestors` entirely (the whole point of the proxy);
*  2. append `'self'` to every resource directive the embedded app needs for
*     same-origin loads (the bridge script, lazily inserted chunks, editor
*     data calls, the socket.io tunnel) when that directive exists;
*  3. when only `default-src` exists, append `'self'` there instead.
* Everything else — every host allowlist entry — is preserved verbatim, so
* the policy still blocks everything it blocked before except same-origin.
*/
const SELF_NEEDED_DIRECTIVES = /* @__PURE__ */ new Set([
	"script-src",
	"style-src",
	"img-src",
	"font-src",
	"connect-src",
	"media-src",
	"worker-src",
	"child-src"
]);
function allowSelfInCsp(value, extraOrigins = []) {
	let changed = false;
	const kept = [];
	let hasScriptSrc = false;
	let hasDefaultSrc = false;
	const extras = extraOrigins.filter((origin) => origin !== "" && !value.includes(origin));
	for (const rawDirective of value.split(";").map((item) => item.trim()).filter(Boolean)) {
		if (/^frame-ancestors\b/i.test(rawDirective)) {
			changed = true;
			continue;
		}
		const match = /^([a-z-]+)(?:\s+([\s\S]*))?$/.exec(rawDirective);
		if (match === null) {
			kept.push(rawDirective);
			continue;
		}
		const name = (match[1] ?? "").toLowerCase();
		const values = (match[2] ?? "").trim();
		if (name === "script-src") hasScriptSrc = true;
		if (name === "default-src") hasDefaultSrc = true;
		if (name === "base-uri" && /'none'/i.test(values)) {
			changed = true;
			kept.push("base-uri 'self'");
			continue;
		}
		if (SELF_NEEDED_DIRECTIVES.has(name) && !/(?:^|\s)'self'(?:\s|$)/i.test(values)) {
			changed = true;
			kept.push(values === "" ? `${name} 'self'` : `${name} ${values} 'self'`);
			continue;
		}
		if (name === "connect-src" && extras.length > 0) {
			changed = true;
			kept.push(values === "" ? `${name} ${extras.join(" ")}` : `${name} ${values} ${extras.join(" ")}`);
			continue;
		}
		kept.push(rawDirective);
	}
	if (!hasScriptSrc && hasDefaultSrc) {
		const index = kept.findIndex((directive) => /^default-src\b/i.test(directive));
		const directive = index >= 0 ? kept[index] : void 0;
		if (directive !== void 0) {
			const values = directive.replace(/^default-src\b/i, "").trim();
			const additions = [...!/(?:^|\s)'self'(?:\s|$)/i.test(values) ? ["'self'"] : [], ...extras];
			if (additions.length > 0) {
				changed = true;
				kept[index] = values === "" ? `default-src ${additions.join(" ")}` : `default-src ${values} ${additions.join(" ")}`;
			}
		}
	}
	return {
		value: kept.join("; "),
		changed
	};
}
/** Remove only the framing directives from a Content-Security-Policy value. */
function relaxFrameCsp(value) {
	const kept = [];
	let changed = false;
	for (const directive of value.split(";").map((item) => item.trim()).filter(Boolean)) {
		if (/^frame-ancestors\b/i.test(directive)) {
			changed = true;
			continue;
		}
		kept.push(directive);
	}
	return {
		value: kept.join("; "),
		changed
	};
}
/** Strip Domain= from one Set-Cookie attribute list (cookie lands host-only). */
function scopeSetCookieToHost(setCookieLine) {
	return setCookieLine.replace(/;\s*domain=[^;]*/gi, "");
}
/**
* Merge two Cookie header strings without duplicated names; later entries win.
* NOTE: since v0.1.6 the proxy no longer mixes browser and stored cookies for
* upstream auth requests — the stored credential is sent verbatim when it
* exists (a browser-side anonymous twin of the session cookie must never be
* able to override it). This helper remains for tests and external callers.
*/
function mergeCookieHeaders(base, extra) {
	const entries = [];
	for (const source of [base, extra]) {
		if (source === void 0 || source.trim() === "") continue;
		for (const pair of source.split(";")) {
			const item = pair.trim();
			if (item === "") continue;
			const equals = item.indexOf("=");
			if (equals <= 0) continue;
			const name = item.slice(0, equals).trim();
			if (name === "") continue;
			const existing = entries.findIndex((entry) => entry.startsWith(`${name}=`));
			if (existing >= 0) entries.splice(existing, 1);
			entries.push(item);
		}
	}
	return entries.length > 0 ? entries.join("; ") : void 0;
}
/**
* Cookies whose value is deliberately rotated by an edge/load-balancer layer.
*
* A saved login header is the authority for application session cookies (this
* prevents an anonymous browser-side `overleaf_session2` from replacing the
* authenticated value).  Edge-affinity cookies are different: the response to
* the Socket.IO handshake can rotate them immediately, and the subsequent
* WebSocket upgrade must echo that latest browser value or it can reach a
* different backend where the freshly issued socket id does not exist.
*/
function isRuntimeRoutingCookie(name) {
	return /^(?:gclb|awsalb(?:cors|app-\d+)?|route|serverid|bigipserver.*|__cf_bm|cf_clearance|ak_bmsc|bm_sv|acw_tc|cdn_sec_tc)$/i.test(name) || /^(?:incap_ses_|visid_incap_)/i.test(name);
}
/**
* Merge the browser's live cookie jar with the stored login credential.
* Stored values win for normal/session cookies; a live browser value wins for
* known routing cookies so an HTTP handshake and its WebSocket upgrade stay on
* the same upstream worker.
*/
function mergeProxyCookieHeaders(browserCookie, storedCookie) {
	if (storedCookie === void 0 || storedCookie.trim() === "") return browserCookie;
	if (browserCookie === void 0 || browserCookie.trim() === "") return storedCookie;
	const liveRoutingNames = /* @__PURE__ */ new Set();
	for (const pair of browserCookie.split(";")) {
		const item = pair.trim();
		const equals = item.indexOf("=");
		if (equals <= 0) continue;
		const name = item.slice(0, equals).trim();
		if (isRuntimeRoutingCookie(name)) liveRoutingNames.add(name.toLowerCase());
	}
	return mergeCookieHeaders(browserCookie, storedCookie.split(";").map((item) => item.trim()).filter((item) => {
		const equals = item.indexOf("=");
		if (equals <= 0) return false;
		const name = item.slice(0, equals).trim();
		return !(isRuntimeRoutingCookie(name) && liveRoutingNames.has(name.toLowerCase()));
	}).join("; "));
}
/** Compute the upstream sub-path (with query) for one matched request URL. */
function subPathOf(rawUrl, prefix) {
	const raw = rawUrl ?? "/";
	if (raw === prefix) return "/";
	if (raw.startsWith(`${prefix}/`)) return raw.slice(prefix.length);
	return raw;
}
/** Give synchronous Overleaf compile calls enough time without weakening every route. */
function requestTimeoutFor(target) {
	return /\/project\/[^/]+\/compile\/?$/.test(target.pathname) ? COMPILE_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
}
/** Does the request path belong to a learned user-content origin? A rule with
*  a disclosed prefix is exact; the bare-host fallback only accepts paths
*  shaped like per-user build outputs (zone-scoped or `user/<uid>`), never an
*  application page. */
function contentPathMatches(subPath, rule) {
	if (rule.prefix !== "") return subPath === rule.prefix || subPath.startsWith(`${rule.prefix}/`);
	return /^\/(?:zone\/[^/]+\/|project\/[0-9a-fA-F]{24}\/user\/)/.test(subPath);
}
/**
* Extract the user-content origin hint from one proxied HTML body (the meta
* tag shape used by Overleaf shells; attribute order is not guaranteed).
*/
function extractContentDomainFromHtml(html) {
	for (const name of ["ol-compilesUserContentDomain", "ol-userContentDomain"]) {
		const forward = new RegExp(`<meta\\s+[^>]*name=["']${name}["'][^>]*content=["']([^"']+)["']`, "i").exec(html);
		if (forward?.[1] !== void 0 && forward[1] !== "") return forward[1];
		const reverse = new RegExp(`<meta\\s+[^>]*content=["']([^"']+)["'][^>]*name=["']${name}["']`, "i").exec(html);
		if (reverse?.[1] !== void 0 && reverse[1] !== "") return reverse[1];
	}
}
/**
* Extract user-content origin hints from proxied JSON bodies (compile result
* `pdfDownloadDomain`/`outputUrlPrefix`, cached-output `downloadURL`). Each
* returned value is a full base URL the frontend prepends to output-file
* paths, e.g. `https://compiles.overleafusercontent.com/zone/c`.
*/
function extractContentHintsFromJson(jsonText) {
	const hints = [];
	const add = (value) => {
		if (value === void 0 || value === "") return;
		try {
			const parsed = new URL(value);
			if (parsed.protocol === "https:" || parsed.protocol === "http:") hints.push(value);
		} catch {}
	};
	add(/"pdfDownloadDomain"\s*:\s*"([^"]+)"/.exec(jsonText)?.[1]);
	const prefix = /"outputUrlPrefix"\s*:\s*"([^"]+)"/.exec(jsonText)?.[1];
	if (prefix !== void 0 && prefix.trim() !== "") {
		const download = /"downloadURL"\s*:\s*"((?:https?:\/\/)[^"]+)"/.exec(jsonText)?.[1];
		if (download !== void 0) try {
			add(`${new URL(download).origin}${prefix.startsWith("/") ? "" : "/"}${prefix.replace(/\/+$/, "")}`);
		} catch {}
	}
	for (const match of jsonText.matchAll(/"downloadURL"\s*:\s*"((?:https?:\/\/)[^"]+)"/g)) {
		const rawUrl = match[1];
		if (rawUrl === void 0) continue;
		try {
			add(new URL(rawUrl).origin);
		} catch {}
	}
	return [...new Set(hints)];
}
/** Forward selection of inbound request headers toward one upstream request. */
function buildUpstreamHeaders(req, target, extraCookie) {
	const headers = {};
	for (const [name, value] of Object.entries(req.headers)) {
		const lower = name.toLowerCase();
		if (HOP_BY_HOP.has(lower)) continue;
		if (lower === "host" || lower === "cookie" || lower === "accept-encoding") continue;
		headers[name] = Array.isArray(value) ? [...value] : value;
	}
	headers["origin"] = target.origin;
	const referer = headers["referer"];
	if (typeof referer === "string") headers["referer"] = referer.replaceAll("/overleaf-proxy", "");
	headers["host"] = target.host;
	headers["accept-encoding"] = "identity";
	const mergedCookie = mergeProxyCookieHeaders(typeof req.headers.cookie === "string" ? req.headers.cookie : void 0, extraCookie);
	if (mergedCookie !== void 0 && mergedCookie !== "") headers["cookie"] = mergedCookie;
	return headers;
}
/** Copy upstream response headers onto the outbound response, adjusted. */
function buildResponseHeaders(upstreamHeaders, prefix, target, wsAllowOrigin) {
	const headers = {};
	let hadFrameCsp = false;
	for (const [name, value] of Object.entries(upstreamHeaders)) {
		const lower = name.toLowerCase();
		if (HOP_BY_HOP.has(lower)) continue;
		if (lower === "x-frame-options") continue;
		if (lower === "content-security-policy") continue;
		if (lower === "set-cookie") {
			const scoped = (Array.isArray(value) ? value : [value]).filter((item) => typeof item === "string").map(scopeSetCookieToHost);
			if (scoped.length > 0) headers[name] = scoped;
			continue;
		}
		if (value === void 0) continue;
		if (lower === "location" && typeof value === "string") {
			try {
				const resolved = new URL(value, target);
				headers[name] = resolved.origin === target.origin ? `${prefix}${resolved.pathname}${resolved.search}${resolved.hash}` : value;
			} catch {
				headers[name] = value;
			}
			continue;
		}
		headers[name] = value;
	}
	const csp = upstreamHeaders["content-security-policy"];
	if (csp !== void 0) {
		const adjusted = allowSelfInCsp(Array.isArray(csp) ? csp.join("; ") : csp, wsAllowOrigin !== void 0 ? [wsAllowOrigin] : []);
		hadFrameCsp = adjusted.changed;
		if (adjusted.value !== "") headers["content-security-policy"] = adjusted.value;
	}
	return {
		headers,
		hadFrameCsp
	};
}
/**
* One streaming reverse proxy bound to a single upstream origin. Instances are
* cheap; update the stored credential by assigning `extraCookie`.
*/
var ReverseProxy = class {
	target;
	constructor(origin) {
		this.target = new URL(origin);
	}
	/** Cookie header injected into every upstream request (may be undefined). */
	extraCookie = void 0;
	/** Bridge script src injected into rewritten HTML bodies (undefined disables). */
	injectScriptSrc = void 0;
	/** Loopback origin of the companion WS tunnel port (ws://127.0.0.1:port). */
	wsAllowOrigin = void 0;
	/** Port of the companion WS tunnel server (0 until it starts listening). */
	wsPort = 0;
	/** User-content output-file origin learned from the site's own hints. */
	contentRule = void 0;
	/**
	* Register a user-content origin hint (e.g. `https://compiles
	* .overleafusercontent.com/zone/c`). The hint with the most specific path
	* prefix learned so far wins, so the zone-precise compile JSON hint
	* survives later origin-only meta tags.
	*/
	learnContentHint(value) {
		try {
			const parsed = new URL(value);
			const prefix = parsed.pathname === "/" || parsed.pathname === "" ? "" : parsed.pathname.replace(/\/+$/, "");
			if (this.contentRule === void 0 || prefix.length > this.contentRule.prefix.length) this.contentRule = {
				origin: new URL(parsed.origin),
				prefix
			};
		} catch {}
	}
	/**
	* Upstream target for one matched sub-path: the locked main origin, or the
	* learned user-content origin when the path belongs to its zone.
	*/
	targetFor(subPath) {
		const rule = this.contentRule;
		if (rule !== void 0 && contentPathMatches(subPath, rule)) return new URL(subPath, rule.origin);
		return new URL(subPath, this.target);
	}
	/** Whether the given raw request URL belongs to this proxy. */
	matches(rawUrl) {
		if (rawUrl === void 0) return false;
		return rawUrl === "/overleaf-proxy" || rawUrl.startsWith(`/overleaf-proxy/`);
	}
	/** Handle one matched proxied HTTP request end-to-end. */
	async handle(req, res) {
		const subPath = subPathOf(req.url, PROXY_PREFIX);
		const target = this.targetFor(subPath);
		const upstreamHeaders = buildUpstreamHeaders(req, target, this.extraCookie);
		await new Promise((resolveProxy) => {
			let settled = false;
			const settle = () => {
				if (!settled) {
					settled = true;
					resolveProxy();
				}
			};
			const requestlib = target.protocol === "https:" ? https : http;
			let upstream;
			try {
				upstream = requestlib.request(target, {
					method: req.method,
					headers: upstreamHeaders,
					timeout: requestTimeoutFor(target)
				}, (upstreamRes) => {
					deliverResponse(res, upstreamRes, target, this.injectScriptSrc, this.wsAllowOrigin, this.wsPort, (hint) => {
						this.learnContentHint(hint);
					}, settle);
				});
			} catch (error) {
				respondBadGateway(res, error);
				settle();
				return;
			}
			upstream.on("timeout", () => upstream.destroy(/* @__PURE__ */ new Error("dsh-overleaf: upstream request timeout")));
			upstream.on("error", (error) => {
				respondBadGateway(res, error);
				settle();
			});
			req.on("aborted", () => {
				upstream.destroy();
				settle();
			});
			req.pipe(upstream);
		});
	}
	/**
	* Tunnel an upgraded socket (WebSocket) to the same upstream origin. Called
	* through `webServer.registerUpgrade` for the exact pathname(s) the embedded
	* site uses; the handler owns protocol negotiation from here on.
	*/
	tunnelUpgrade(req, socket, head) {
		const subPath = subPathOf(req.url, PROXY_PREFIX);
		const isTls = this.target.protocol === "https:";
		const port = Number(this.target.port) || (isTls ? 443 : 80);
		let upstreamSocket;
		const destroyBoth = () => {
			socket.destroy();
			upstreamSocket?.destroy();
		};
		const connectCallback = () => {
			try {
				writeUpgradeRequest(req, subPath, this.target, this.extraCookie, upstreamSocket, head);
				spliceSockets(socket, upstreamSocket, destroyBoth);
			} catch {
				destroyBoth();
			}
		};
		upstreamSocket = isTls ? connect({
			host: this.target.hostname,
			port,
			servername: this.target.hostname
		}, connectCallback) : net.connect({
			host: this.target.hostname,
			port
		}, connectCallback);
		upstreamSocket.setTimeout(UPGRADE_CONNECT_TIMEOUT_MS);
		upstreamSocket.once("timeout", () => destroyBoth());
		upstreamSocket.once("error", destroyBoth);
		socket.once("error", destroyBoth);
	}
};
/** Stream one upstream HTTP response to the client, rewriting small HTML bodies. */
async function deliverResponse(res, upstreamRes, target, injectScriptSrc, wsAllowOrigin, wsPort, learnContent, settle) {
	const contentTypeHeader = upstreamRes.headers["content-type"];
	const contentType = typeof contentTypeHeader === "string" ? contentTypeHeader.toLowerCase() : "";
	const isHtml = contentType.includes("text/html");
	const isCss = contentType.includes("text/css");
	const isProjectJson = contentType.includes("application/json") && /^\/project\/[^/]+\//.test(target.pathname);
	const { headers, hadFrameCsp } = buildResponseHeaders(upstreamRes.headers, PROXY_PREFIX, target, wsAllowOrigin);
	if (hadFrameCsp && process.env.DSH_OVERLEAF_DEBUG === "1") console.warn("[dsh-overleaf] stripped frame-ancestors CSP for", target.pathname);
	if (isCss) {
		const chunksCss = [];
		let sizeCss = 0;
		let overflowCss = false;
		upstreamRes.on("data", (chunk) => {
			if (overflowCss) return;
			sizeCss += chunk.byteLength;
			if (sizeCss > MAX_REWRITE_BODY_BYTES) {
				overflowCss = true;
				res.writeHead(upstreamRes.statusCode ?? 502, headers);
				const remaining = upstreamRes.readableLength > 0 ? [upstreamRes.read()] : [];
				for (const buffered of [...chunksCss, ...remaining.filter((item) => item !== null)]) res.write(buffered);
				upstreamRes.pipe(res);
				return;
			}
			chunksCss.push(chunk);
		});
		upstreamRes.on("close", settle);
		upstreamRes.on("end", () => {
			if (overflowCss) {
				settle();
				return;
			}
			try {
				const body = rewriteCss(Buffer.concat(chunksCss).toString("utf8"), PROXY_PREFIX);
				const payload = Buffer.from(body, "utf8");
				const finalHeaders = { ...headers };
				finalHeaders["content-length"] = String(payload.byteLength);
				res.writeHead(upstreamRes.statusCode ?? 502, finalHeaders);
				res.end(payload);
			} catch {
				res.destroy();
			}
			settle();
		});
		return;
	}
	if (!isHtml && !isProjectJson) {
		res.writeHead(upstreamRes.statusCode ?? 502, headers);
		upstreamRes.pipe(res);
		upstreamRes.on("close", settle);
		return;
	}
	if (isProjectJson) {
		const chunksJson = [];
		let sizeJson = 0;
		let overflowJson = false;
		upstreamRes.on("data", (chunk) => {
			if (overflowJson) return;
			sizeJson += chunk.byteLength;
			if (sizeJson > MAX_REWRITE_BODY_BYTES) {
				overflowJson = true;
				res.writeHead(upstreamRes.statusCode ?? 502, headers);
				const remaining = upstreamRes.readableLength > 0 ? [upstreamRes.read()] : [];
				for (const buffered of [...chunksJson, ...remaining.filter((item) => item !== null)]) res.write(buffered);
				upstreamRes.pipe(res);
				return;
			}
			chunksJson.push(chunk);
		});
		upstreamRes.on("close", settle);
		upstreamRes.on("end", () => {
			if (overflowJson) {
				settle();
				return;
			}
			const jsonText = Buffer.concat(chunksJson).toString("utf8");
			for (const hint of extractContentHintsFromJson(jsonText)) learnContent(hint);
			res.writeHead(upstreamRes.statusCode ?? 502, headers);
			res.end(Buffer.concat(chunksJson));
			settle();
		});
		return;
	}
	const chunks = [];
	let size = 0;
	let overflowed = false;
	upstreamRes.on("data", (chunk) => {
		if (overflowed) return;
		size += chunk.byteLength;
		if (size > MAX_REWRITE_BODY_BYTES) {
			overflowed = true;
			res.writeHead(upstreamRes.statusCode ?? 502, headers);
			const remaining = upstreamRes.readableLength > 0 ? [upstreamRes.read()] : [];
			for (const buffered of [...chunks, ...remaining.filter((item) => item !== null)]) res.write(buffered);
			upstreamRes.pipe(res);
			return;
		}
		chunks.push(chunk);
	});
	upstreamRes.on("close", settle);
	upstreamRes.on("end", () => {
		if (overflowed) {
			settle();
			return;
		}
		try {
			const htmlString = Buffer.concat(chunks).toString("utf8");
			const metaHint = extractContentDomainFromHtml(htmlString);
			if (metaHint !== void 0) learnContent(metaHint);
			const cspHeader = upstreamRes.headers["content-security-policy"];
			const cspNonce = extractCspNonce(Array.isArray(cspHeader) ? cspHeader.join("; ") : cspHeader, htmlString);
			const body = rewriteHtml(htmlString, PROXY_PREFIX, injectScriptSrc, target.origin, cspNonce, wsPort);
			const payload = Buffer.from(body, "utf8");
			const finalHeaders = { ...headers };
			finalHeaders["content-length"] = String(payload.byteLength);
			res.writeHead(upstreamRes.statusCode ?? 502, finalHeaders);
			res.end(payload);
		} catch {
			res.destroy();
		}
		settle();
	});
}
/** Answer with the shared JSON 502 envelope when the upstream call fails. */
function respondBadGateway(res, error) {
	if (res.writableEnded) return;
	if (res.headersSent) {
		res.destroy();
		return;
	}
	res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
	res.end(JSON.stringify({
		ok: false,
		error: {
			code: "dsh-overleaf-upstream-error",
			message: error instanceof Error ? error.message : String(error)
		}
	}));
}
/** Write the synthetic GET-upgrade request down the freshly opened socket. */
function writeUpgradeRequest(req, subPath, target, extraCookie, upstreamSocket, head) {
	const lines = [`GET ${subPath} HTTP/1.1`, `Host: ${target.host}`];
	for (const [name, value] of Object.entries(req.headers)) {
		const lower = name.toLowerCase();
		if (lower === "host" || lower === "cookie" || lower === "origin" || lower === "referer") continue;
		if (lower === "te" || lower === "trailer" || lower === "proxy-authenticate" || lower === "proxy-authorization") continue;
		for (const item of Array.isArray(value) ? value : [value]) if (item !== void 0 && item !== "") lines.push(`${name}: ${item}`);
	}
	if (typeof req.headers.origin === "string") lines.push(`Origin: ${target.origin}`);
	const mergedCookie = mergeProxyCookieHeaders(typeof req.headers.cookie === "string" ? req.headers.cookie : void 0, extraCookie);
	if (mergedCookie !== void 0 && mergedCookie !== "") lines.push(`Cookie: ${mergedCookie}`);
	lines.push("", "");
	upstreamSocket.write(lines.join("\r\n"));
	if (head.length > 0) upstreamSocket.write(head);
}
/** Pipe both directions between client and upgraded upstream sockets. */
function spliceSockets(clientSocket, upstreamSocket, teardown) {
	upstreamSocket.pipe(clientSocket);
	clientSocket.pipe(upstreamSocket);
	clientSocket.on("close", teardown);
	upstreamSocket.on("close", teardown);
}
//#endregion
//#region lib/types/inject-script.js
/**
* The dsh-overleaf bridge script. Served same-origin at
* `/overleaf-workbench/bridge.js` and injected as an external classic script
* right after `<head>` on every proxied HTML response (external same-origin
* script survives strict `script-src 'self'` CSPs where inline handlers fail).
*
* Responsibilities:
*  - Route every same-origin root-relative URL (fetch/XHR/EventSource/
*    WebSocket/link/form/navigation) under the proxy prefix by combining a
*    document-level `<base>` (written by the proxy rewrite) with defensive
*    runtime wrappers installed here at document start.
*  - Report text selections to the GUI shell (R5 quote pipeline source).
*  - Insert generated text at the editor caret (R6) with a local snapshot +
*    rollback buffer.
*  - Scroll to & flash a quoted range when the composer chip asks (R5).
*/
/**
* Raw browser-side script. Kept as one double-quoted-free normal TS string;
* build copies it verbatim into the bundle.
*/
const BRIDGE_SCRIPT_NAME = "bridge.js";
function renderBridgeScript() {
	return `/* dsh-overleaf bridge v1 (auto-generated by the plugin host; do not edit) */
;(function () {
  'use strict'
  var NS = 'dsh-overleaf'
  if (window.__DSH_OVERLEAF_BRIDGE__) return
  window.__DSH_OVERLEAF_BRIDGE__ = true
  var DEBUG = false
  function markDiagnostic(name, value) {
    try {
      if (document.documentElement) {
        document.documentElement.setAttribute('data-dsh-overleaf-' + name, String(value).slice(0, 300))
      }
    } catch (err) {}
  }
  markDiagnostic('bridge', 'ready')
  window.addEventListener('error', function (event) {
    markDiagnostic('last-error', event && event.message ? event.message : 'script-error')
  })
  window.addEventListener('unhandledrejection', function (event) {
    var reason = event && event.reason
    markDiagnostic('last-rejection', reason && reason.message ? reason.message : String(reason || 'unhandled-rejection'))
  })
  function log() {
    if (!DEBUG || !console || !console.debug) return
    Function.prototype.apply.call(console.debug, console, ['[dsh-overleaf]'].concat([].slice.call(arguments)))
  }
  function safe(fn, label) {
    return function () {
      try {
        return fn.apply(this, arguments)
      } catch (err) {
        if (DEBUG) log(label, err)
        return undefined
      }
    }
  }
  var PREFIX = '/overleaf-proxy'
  function sendToParent(message) {
    try {
      if (window.parent && window.parent !== window) {
        message.ns = NS
        window.parent.postMessage(message, '*')
      }
    } catch (err) {
      if (DEBUG) log('send failed', err)
    }
  }

  /* ---------------------------------------------------------------- */
  /* Request routing helpers                                          */
  /* ---------------------------------------------------------------- */

  function isProxyUrl(value) {
    return typeof value === 'string' && (value.indexOf(PREFIX + '/') === 0)
  }

  /* User-content output-file origin (Overleaf serves PDFs/logs from a second
     host - compiles.overleafusercontent.com - announced in the shell meta tag
     ol-compilesUserContentDomain). The compile-result URL builder prepends
     that absolute host to output-file paths with window.origin semantics, so
     fetches escape the embedded origin and are CORS-blocked. Re-rooting them
     under the proxy lets the same-origin tunnel fetch the bytes (the locked
     main origin 404s on those paths). The meta may not be parsed yet while
     this script runs (it is injected right after <head>), so the lookup
     retries until it lands. */
  var contentOriginSeen = false
  var contentOriginValue = ''
  function readContentOrigin() {
    try {
      var metas = document.querySelectorAll('meta[name="ol-compilesUserContentDomain"], meta[name="ol-userContentDomain"]')
      for (var i = 0; i < metas.length; i++) {
        if (metas[i] && metas[i].content) return String(metas[i].content)
      }
    } catch (err) {}
    return undefined
  }
  function contentOrigin() {
    if (!contentOriginSeen) {
      var raw = readContentOrigin()
      if (raw !== undefined && raw !== '') {
        try {
          contentOriginValue = new URL(raw).origin
          markDiagnostic('content-origin', contentOriginValue)
        } catch (err) {
          contentOriginValue = ''
        }
        contentOriginSeen = true
      }
      /* else: meta not parsed yet - retry on the next request */
    }
    return contentOriginValue
  }

  function routeUrl(raw) {
    try {
      if (raw instanceof URL) raw = raw.toString()
      if (typeof raw !== 'string') return raw
      // Root-relative upstream URLs are re-rooted under the proxy.
      if (raw.charAt(0) === '/') {
        if (!isProxyUrl(raw)) return PREFIX + raw
        return raw
      }
      // Overleaf's compile result builder deliberately turns output-file paths
      // into absolute URLs with window.origin + file.url. Inside the embedded
      // page, window.origin is the DSH loopback shell, so those PDF/log fetches
      // bypass the proxy unless absolute same-origin URLs are re-rooted too.
      // Relative strings are left alone so the injected <base> keeps handling
      // their root semantics; external/CDN/blob/data origins remain untouched.
      var isAbsolute = raw.indexOf('//') === 0 || /^[a-z][a-z0-9+.-]*:/i.test(raw)
      if (isAbsolute) {
        var parsed = new URL(raw.indexOf('//') === 0 ? location.protocol + raw : raw)
        var isWorkbenchRoute = parsed.pathname.indexOf('/overleaf/workbench/') === 0
        var isAlreadyProxied = parsed.pathname === PREFIX || parsed.pathname.indexOf(PREFIX + '/') === 0
        if (parsed.origin === window.location.origin && !isWorkbenchRoute && !isAlreadyProxied) {
          return window.location.origin + PREFIX + parsed.pathname + parsed.search + parsed.hash
        }
        // Absolute URLs on the site's user-content output origin are re-rooted
        // under the proxy (keeps the path - the host proxy forwards zone paths
        // to that origin after learning it from the compile result).
        var contentDom = contentOrigin()
        if (contentDom !== '' && parsed.origin === contentDom && !isWorkbenchRoute && !isAlreadyProxied) {
          return PREFIX + parsed.pathname + parsed.search + parsed.hash
        }
      }
      return raw
    } catch (err) {
      return raw
    }
  }

  /* ---------------------------------------------------------------- */
  /* Compile-log capture (auto-fix source)                             */
  /*                                                                    */
  /* The panel's compile-fix tab needs the raw compiler output. Every    */
  /* compile POST and every output.pdf load passes the fetch/XHR        */
  /* wrappers below; when one is seen, the same build's output.log      */
  /* (and .blg) are fetched through the proxy and published to the      */
  /* shell. NOTE: this file is generated from a TS template literal -   */
  /* every regex backslash must be doubled, and no backtick or dollar-  */
  /* brace sequence may appear (even in comments).                      */
  /* ---------------------------------------------------------------- */
  var lastCompileStatus = undefined
  var lastCompileLogs = undefined
  var logFetchInFlight = false

  function pathnameOf(rawUrl) {
    try {
      if (rawUrl instanceof URL) rawUrl = rawUrl.toString()
      if (typeof rawUrl !== 'string' || rawUrl === '') return ''
      var absolute = rawUrl.indexOf('//') === 0
        ? location.protocol + rawUrl
        : (/^[a-z][a-z0-9+.-]*:/i.test(rawUrl) ? rawUrl : location.origin + (rawUrl.charAt(0) === '/' ? rawUrl : '/' + rawUrl))
      return new URL(absolute).pathname
    } catch (err) {
      return ''
    }
  }

  function isCompilePost(rawUrl) {
    return /^\\/project\\/[^/]+\\/compile\\/?$/.test(pathnameOf(rawUrl))
  }

  function isOutputPdf(rawUrl) {
    return /\\/output\\/output\\.pdf(?:[?#]|$)/.test(pathnameOf(rawUrl))
  }

  function truncateText(text, max) {
    if (typeof text !== 'string') return ''
    return text.length > max ? text.slice(0, max) + '\\n...[truncated]' : text
  }

  function fetchWithTimeout(url) {
    try {
      var controller = typeof AbortController === 'function' ? new AbortController() : undefined
      if (controller) setTimeout(function () { try { controller.abort() } catch (err) {} }, 30000)
      return window.fetch(url, {
        cache: 'no-store',
        signal: controller ? controller.signal : undefined,
      })
    } catch (err) {
      return Promise.reject(err)
    }
  }

  function publishCompileLog() {
    sendToParent({
      type: 'compile-log',
      status: lastCompileStatus || 'unknown',
      files: lastCompileLogs || [],
    })
  }

  function fetchAndPublishLog(fullUrl, pathName) {
    if (logFetchInFlight) return
    logFetchInFlight = true
    fetchWithTimeout(fullUrl)
      .then(function (response) {
        if (!response.ok) return { path: pathName, text: '', error: 'HTTP ' + response.status }
        return response.text().then(function (text) {
          return { path: pathName, text: truncateText(text, 262144) }
        })
      })
      .then(function (captured) {
        var previous = lastCompileLogs || []
        var rest = previous.filter(function (item) { return item && item.path !== pathName })
        lastCompileLogs = rest.concat([captured])
        publishCompileLog()
      })
      .catch(function (err) {
        if (DEBUG) log('compile log fetch failed', err)
      })
      .finally(function () { logFetchInFlight = false })
  }

  /* Observed on a compile POST response: read outputFiles, fetch every
     .log/.blg through the proxy with the same compileGroup/clsiServerId
     query the frontend uses. */
  function captureCompileResponse(json) {
    try {
      if (!json || !json.outputFiles || !Array.isArray(json.outputFiles)) return
      if (typeof json.status === 'string') lastCompileStatus = json.status
      var pdfDomain = typeof json.pdfDownloadDomain === 'string' ? json.pdfDownloadDomain : ''
      var params = new URLSearchParams()
      if (json.compileGroup) params.set('compileGroup', String(json.compileGroup))
      if (json.clsiServerId) params.set('clsiserverid', String(json.clsiServerId))
      params.set('enable_pdf_caching', 'true')
      var query = params.toString()
      var found = []
      for (var i = 0; i < json.outputFiles.length; i++) {
        var entry = json.outputFiles[i]
        var filePath = entry && typeof entry.path === 'string' ? entry.path : ''
        var relUrl = entry && typeof entry.url === 'string' ? entry.url : ''
        if (!/\\.(?:log|blg)$/i.test(filePath) || relUrl === '' || found.length >= 4) continue
        var target = pdfDomain !== '' && relUrl.charAt(0) === '/'
          ? pdfDomain + relUrl
          : relUrl
        found.push({ path: filePath, url: target + (query !== '' ? '?' + query : '') })
      }
      for (var j = 0; j < found.length; j++) {
        fetchAndPublishLog(found[j].url, found[j].path)
      }
    } catch (err) {
      if (DEBUG) log('compile capture failed', err)
    }
  }

  /* Fallback: an output.pdf load also reveals the build path - fetch the
     companion output.log with the SAME query the pdf request carried. */
  function captureLogFromOutputPdf(rawUrl) {
    try {
      var absolute = rawUrl.indexOf('//') === 0
        ? location.protocol + rawUrl
        : (/^[a-z][a-z0-9+.-]*:/i.test(rawUrl) ? rawUrl : location.origin + rawUrl)
      var parsed = new URL(absolute)
      if (!/\\.pdf$/i.test(parsed.pathname)) return
      parsed.pathname = parsed.pathname.replace(/\\.pdf$/i, '.log')
      fetchAndPublishLog(parsed.toString(), 'output.log')
    } catch (err) {
      if (DEBUG) log('pdf log fallback failed', err)
    }
  }

  function currentDocName() {
    try {
      var candidates = document.querySelectorAll('.document-title, [class*="document-title"], [class*="doc-title"], [class*="file-tree"] [class*="name"]')
      for (var i = 0; i < candidates.length; i++) {
        if (candidates[i] && candidates[i].textContent) {
          var text = String(candidates[i].textContent).trim()
          if (text !== '' && text.length < 120) return text
        }
      }
    } catch (err) {}
    return 'current-document'
  }

  /* Apply a validated edit list (each old must match once) to the live
     editor document, from the LAST edit backwards so ranges stay valid. */
  function applyFixEdits(edits) {
    try {
      if (!Array.isArray(edits) || edits.length === 0) {
        sendToParent({ type: 'fix-applied', ok: false, error: 'no-edits' })
        return
      }
      var cm5 = findCm5()
      if (cm5) {
        var doc5 = String(cm5.getValue())
        var steps5 = buildFixSteps(edits, doc5)
        if (!steps5.ok) { sendToParent({ type: 'fix-applied', ok: false, error: steps5.error, detail: steps5.detail }); return }
        rememberSnapshot(doc5)
        var sorted5 = steps5.steps.slice().sort(function (a, b) { return b.from - a.from })
        for (var s5 = 0; s5 < sorted5.length; s5++) {
          cm5.replaceRange(sorted5[s5].replacement, cm5.posFromIndex(sorted5[s5].from), cm5.posFromIndex(sorted5[s5].to))
        }
        cm5.focus()
        sendToParent({ type: 'fix-applied', ok: true, applied: sorted5.length })
        return
      }
      var cm6 = findCm6()
      if (cm6) {
        var doc6 = cm6.state.doc.toString()
        var steps6 = buildFixSteps(edits, doc6)
        if (!steps6.ok) { sendToParent({ type: 'fix-applied', ok: false, error: steps6.error, detail: steps6.detail }); return }
        rememberSnapshot(doc6)
        var sorted6 = steps6.steps.slice().sort(function (a, b) { return b.from - a.from })
        cm6.dispatch({
          changes: sorted6.map(function (step) { return { from: step.from, to: step.to, insert: step.replacement } }),
        })
        cm6.focus()
        sendToParent({ type: 'fix-applied', ok: true, applied: sorted6.length })
        return
      }
      sendToParent({ type: 'fix-applied', ok: false, error: 'no-editor' })
    } catch (err) {
      sendToParent({ type: 'fix-applied', ok: false, error: err && err.message ? err.message : String(err) })
    }
  }

  function buildFixSteps(edits, doc) {
    var steps = []
    for (var i = 0; i < edits.length; i++) {
      var edit = edits[i]
      var oldText = edit && typeof edit.old === 'string' ? edit.old : ''
      var newText = edit && typeof edit.new === 'string' ? edit.new : ''
      if (oldText === '') return { ok: false, error: 'empty-old' }
      if (oldText.length > doc.length) return { ok: false, error: 'not-found', detail: oldText.slice(0, 80) }
      var first = doc.indexOf(oldText)
      if (first < 0) return { ok: false, error: 'not-found', detail: oldText.slice(0, 80) }
      if (doc.indexOf(oldText, first + 1) >= 0) return { ok: false, error: 'not-unique', detail: oldText.slice(0, 80) }
      steps.push({ from: first, to: first + oldText.length, replacement: newText })
    }
    return { ok: true, steps: steps }
  }

  function clickRecompile() {
    try {
      var candidates = document.querySelectorAll('button, [role="button"], [aria-label]')
      for (var i = 0; i < candidates.length; i++) {
        var el = candidates[i]
        var aria = String(el.getAttribute && el.getAttribute('aria-label') || '')
        var title = String(el.getAttribute && el.getAttribute('title') || '')
        var label = String(el.textContent || '').trim()
        if (/^(recompile|compile|重新编译|编译)$/i.test(label) || /^recompile$/i.test(aria) || /^recompile$/i.test(title)) {
          (function (target) {
            setTimeout(function () { try { target.click() } catch (err) {} }, 0)
          })(el)
          sendToParent({ type: 'recompile-clicked', ok: true })
          return
        }
      }
      sendToParent({ type: 'recompile-clicked', ok: false })
    } catch (err) {
      sendToParent({ type: 'recompile-clicked', ok: false })
    }
  }

  /* fetch wrapper */
  var originalFetch = null
  if (typeof window.fetch === 'function') {
    originalFetch = window.fetch
    window.fetch = safe(function (input, init) {
      var rawUrl = typeof input === 'string' ? input : (typeof Request === 'function' && input instanceof Request ? input.url : '')
      if (typeof input === 'string' || input instanceof URL) {
        arguments[0] = routeUrl(input)
      } else if (typeof Request === 'function' && input instanceof Request) {
        // Some PDF loaders pre-build a Request from the absolute output URL.
        // Clone it with the routed URL so method, headers, body and signal are
        // retained while the destination moves under /overleaf-proxy.
        try {
          var routedRequestUrl = routeUrl(input.url)
          if (routedRequestUrl !== input.url) arguments[0] = new Request(routedRequestUrl, input)
        } catch (requestError) {
          if (DEBUG) log('request url fix failed', requestError)
        }
      }
      var routedResult = originalFetch.apply(window, arguments)
      // Compile-fix source: compile POST responses reveal output.log/.blg URLs;
      // an output.pdf load reveals the build path as a fallback.
      if (rawUrl !== '' && isCompilePost(rawUrl)) {
        var fetchMethod = String((init && init.method) || (typeof Request === 'function' && input instanceof Request ? input.method : 'GET')).toUpperCase()
        if (fetchMethod === 'POST') {
          routedResult
            .then(function (response) {
              try {
                response.clone().json()
                  .then(function (json) { captureCompileResponse(json) })
                  .catch(function () {})
              } catch (err) {
                if (DEBUG) log('compile clone failed', err)
              }
            })
            .catch(function () {})
        }
      } else if (rawUrl !== '' && isOutputPdf(rawUrl)) {
        setTimeout(function () { captureLogFromOutputPdf(rawUrl) }, 0)
      }
      return routedResult
    }, 'fetch wrap')
  }

  /* XMLHttpRequest.open wrapper */
  try {
    var proto = window.XMLHttpRequest && window.XMLHttpRequest.prototype
    if (proto && typeof proto.open === 'function') {
      var originalOpen = proto.open
      proto.open = safe(function (method, url) {
        var rawUrl = typeof url === 'string' ? url : ''
        if (typeof url === 'string') {
          arguments[1] = routeUrl(url)
        }
        // XHR backup for the compile-log source (some deployments/issues use
        // XHR for the compile POST - the fetch wrapper alone would miss them).
        if (rawUrl !== '' && typeof this.addEventListener === 'function') {
          try {
            var xhr = this
            xhr.addEventListener('readystatechange', function () {
              if (xhr.readyState !== 4) return
              try {
                if (isCompilePost(rawUrl) && xhr.status === 200 && typeof xhr.responseText === 'string' && xhr.responseText !== '') {
                  var parsedPayload = JSON.parse(xhr.responseText)
                  if (parsedPayload) captureCompileResponse(parsedPayload)
                } else if (isOutputPdf(rawUrl)) {
                  captureLogFromOutputPdf(rawUrl)
                }
              } catch (err) {
                if (DEBUG) log('xhr compile capture failed', err)
              }
            })
          } catch (err) {
            if (DEBUG) log('xhr hook failed', err)
          }
        }
        return originalOpen.apply(this, arguments)
      }, 'xhr wrap')
    }
  } catch (err) {
    if (DEBUG) log('xhr patch skipped', err)
  }

  /* EventSource wrapper.

     MUST use class extends: EventSource is a real DOM constructor and cannot
     be invoked via .call() — the previous prototype-shuffle wrapper made
     EVERY new EventSource(...) on the page throw
     "Failed to construct 'EventSource'" and broke all SSE consumers. */
  try {
    if (typeof window.EventSource === 'function') {
      var OriginalEventSource = window.EventSource
      class PatchedEventSource extends OriginalEventSource {
        constructor(url, config) {
          if (typeof url === 'string') url = routeUrl(url)
          super(url, config)
        }
      }
      Object.defineProperty(PatchedEventSource, 'name', { value: 'EventSource' })
      window.EventSource = PatchedEventSource
    }
  } catch (err) {
    if (DEBUG) log('eventsource patch skipped', err)
  }

  /* WebSocket transport (socket.io websocket upgrade path).

     The webserver's upgrade registry is exact-path only and cannot host
     socket.io's dynamic upgrade URLs, so the plugin runs a companion tunnel
     on its own loopback port (injected as __DSH_OVERLEAF_WS_PORT__). When
     that port is known, same-origin WebSocket targets are redirected there;
     the tunnel forwards the request verbatim to the upstream origin. */
  try {
    var OriginalWebSocket = window.WebSocket
    if (typeof OriginalWebSocket === 'function') {
      var WS_PORT = parseInt(window.__DSH_OVERLEAF_WS_PORT__, 10) || 0
      markDiagnostic('ws-port', WS_PORT)
      function PatchedWebSocket(url, protocols) {
        try {
          if (typeof url === 'string' && url.indexOf('//') === 0) {
            url = (location.protocol === 'https:' ? 'wss:' : 'ws:') + url
          }
          if (typeof url === 'string' && url.charAt(0) === '/') {
            if (WS_PORT > 0) {
              url = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '127.0.0.1:' + WS_PORT + url
            } else {
              url = (location.protocol === 'https:' ? 'wss:' : 'ws:') + window.location.host + PREFIX + url
            }
          } else if (typeof url === 'string' && url.indexOf(window.location.host) !== -1 && !isProxyUrl(url)) {
            if (WS_PORT > 0) {
              var parts = url.split(window.location.host)
              url = parts[0] + '127.0.0.1:' + WS_PORT + parts.slice(1).join(window.location.host)
            } else {
              url = url.replace(location.protocol + '//' + window.location.host,
                location.protocol + '//' + window.location.host + PREFIX)
            }
          }
        } catch (err) {
          if (DEBUG) log('ws url fix failed', err)
        }
        var socketUrl = String(url)
        try {
          var parsedSocketUrl = new URL(socketUrl)
          markDiagnostic('ws-target', parsedSocketUrl.host)
        } catch (err) {
          markDiagnostic('ws-target', 'invalid-url')
        }
        markDiagnostic('ws-state', 'connecting')
        var socket = new OriginalWebSocket(url, protocols)
        socket.addEventListener('open', function () { markDiagnostic('ws-state', 'open') })
        socket.addEventListener('error', function () { markDiagnostic('ws-state', 'error') })
        socket.addEventListener('close', function (event) {
          markDiagnostic('ws-state', 'closed:' + String(event && event.code || 0))
        })
        return socket
      }
      Object.defineProperty(PatchedWebSocket, 'name', { value: 'WebSocket' })
      // Preserve the native constructor contract. Overleaf compares its
      // connection state against WebSocket.OPEN/CLOSED before it ever creates
      // a socket; dropping those static constants makes both sides undefined
      // and canReconnect() stays false forever. Sharing the native prototype
      // also keeps event.target instanceof WebSocket true after wrapping.
      Object.setPrototypeOf(PatchedWebSocket, OriginalWebSocket)
      PatchedWebSocket.prototype = OriginalWebSocket.prototype
      window.WebSocket = PatchedWebSocket
    }
  } catch (err) {
    if (DEBUG) log('websocket patch skipped', err)
  }

  /* navigator.sendBeacon wrapper (analytics endpoints like /event/* are
     POSTed through it and would otherwise bypass the proxy). */
  try {
    if (navigator.sendBeacon && !navigator.sendBeacon.__dshOverleafWrapped) {
      var originalSendBeacon = navigator.sendBeacon.bind(navigator)
      var wrappedSendBeacon = function (url, data) {
        try {
          if (typeof url === 'string') url = routeUrl(url)
        } catch (err) {
          if (DEBUG) log('beacon url fix failed', err)
        }
        return originalSendBeacon(url, data)
      }
      wrappedSendBeacon.__dshOverleafWrapped = true
      Object.defineProperty(navigator, 'sendBeacon', { value: wrappedSendBeacon, configurable: true })
    }
  } catch (err) {
    if (DEBUG) log('sendBeacon patch skipped', err)
  }

  /* Resource-load failure fallback (capture phase - resource errors do not
     bubble). If an IMG/SCRIPT/LINK failed on an un-prefixed root-relative
     URL that slipped past every other rewriter, rebase it in place once and
     let the browser retry. */
  try {
    document.addEventListener('error', safe(function (event) {
      try {
        var el = event.target
        if (!el || el.nodeType !== 1 || !el.getAttribute) return
        var tag = el.tagName
        var attr = tag === 'IMG' ? 'src' : tag === 'SCRIPT' ? 'src' : tag === 'LINK' ? 'href' : null
        if (attr === null) return
        var value = el.getAttribute(attr)
        if (typeof value !== 'string' || value.charAt(0) !== '/' || value.indexOf(PREFIX) === 0
          || value.indexOf('/overleaf/workbench/') === 0) return
        if (el.getAttribute('data-dsh-retried')) return
        el.setAttribute('data-dsh-retried', '1')
        el.setAttribute(attr, PREFIX + value)
      } catch (err) {}
    }, 'resource error fallback'), true)
  } catch (err) {
    if (DEBUG) log('resource fallback skipped', err)
  }

  /* ---------------------------------------------------------------- */
  /* CodeMirror / editor probes                                       */
  /* ---------------------------------------------------------------- */

  function findCm5() {
    try {
      var holders = Array.prototype.slice.call(document.querySelectorAll('.CodeMirror'))
      var instances = []
      for (var i = 0; i < holders.length; i++) {
        var inst = holders[i].CodeMirror
        if (inst) instances.push(inst)
      }
      if (instances.length === 0) return undefined
      var focused = instances.filter(function (cm) { return cm.hasFocus && cm.hasFocus() })
      if (focused.length > 0) return focused[0]
      return instances[0]
    } catch (err) {
      return undefined
    }
  }

  /* Locate the live CodeMirror 6 EditorView. @codemirror/view stores the
     view on the .cm-editor DOM node under the key "cmView", but that field
     is a ContentView wrapper - the EditorView itself sits on its "view"
     property (and may be nested one level deeper), so unwrap before
     validating. NOTE: no backticks or dollar-brace sequences are allowed
     inside this template literal (see v0.1.10 lesson). */
  function asEditorView(candidate) {
    var hop = candidate
    for (var depth = 0; hop && depth < 4; depth++) {
      try {
        if (hop.state && hop.state.doc && typeof hop.dispatch === 'function') return hop
      } catch (err) {}
      hop = hop.view
    }
    return undefined
  }

  function findCm6() {
    try {
      var roots = document.querySelectorAll('.cm-editor')
      for (var i = 0; i < roots.length; i++) {
        var holder = roots[i]
        var direct = asEditorView(holder.cmView)
          || asEditorView(holder.editor)
          || asEditorView(holder.parentNode && holder.parentNode.__codemirrorView)
        if (direct) return direct
        var inner = holder.querySelector && holder.querySelector('.cm-scroller')
        if (inner) {
          var viaInner = asEditorView(inner.cmView)
          if (viaInner) return viaInner
        }
      }
      /* Last resort: scan own properties of editor DOM nodes for an object
         shaped like an EditorView (state.doc + dispatch). */
      var nodes = document.querySelectorAll('.cm-editor, .cm-content, .cm-scroller')
      for (var n = 0; n < nodes.length; n++) {
        var keys = Object.keys(nodes[n] || {})
        for (var k = 0; k < keys.length; k++) {
          var value = null
          try { value = nodes[n][keys[k]] } catch (err) { continue }
          var found = asEditorView(value)
          if (found) return found
        }
      }
      return undefined
    } catch (err) {
      return undefined
    }
  }

  function editorKind(cm) {
    if (!cm) return 'none'
    if (typeof cm.replaceSelection === 'function') return 'cm5'
    if (cm.state && typeof cm.dispatch === 'function') return 'cm6'
    return 'unknown'
  }

  var savedSelection = undefined
  var selectionSequence = 0

  /* Capture editor-native offsets, not just DOM selection text. The stable
     token lets the shell request a delayed replacement after an agent run. */
  function captureEditorSelection() {
    try {
      var cm5 = findCm5()
      if (cm5 && typeof cm5.getCursor === 'function' && typeof cm5.indexFromPos === 'function') {
        var doc5 = String(cm5.getValue())
        var anchor5 = cm5.indexFromPos(cm5.getCursor('anchor'))
        var head5 = cm5.indexFromPos(cm5.getCursor('head'))
        var from5 = Math.min(anchor5, head5)
        var to5 = Math.max(anchor5, head5)
        if (from5 !== to5) return rememberEditorSelection('cm5', cm5, from5, to5, doc5)
      }
      var cm6 = findCm6()
      if (cm6 && cm6.state && cm6.state.selection) {
        var main6 = cm6.state.selection.main
        var from6 = Math.min(main6.from, main6.to)
        var to6 = Math.max(main6.from, main6.to)
        if (from6 !== to6) return rememberEditorSelection('cm6', cm6, from6, to6, cm6.state.doc.toString())
      }
    } catch (err) {
      if (DEBUG) log('editor selection capture failed', err)
    }
    return undefined
  }

  function rememberEditorSelection(engine, editor, from, to, doc) {
    var text = doc.slice(from, to)
    if (!text.trim()) return undefined
    if (savedSelection && savedSelection.engine === engine && savedSelection.editor === editor && savedSelection.from === from
      && savedSelection.to === to && savedSelection.text === text) return savedSelection
    selectionSequence += 1
    savedSelection = {
      id: 'selection-' + Date.now() + '-' + selectionSequence,
      engine: engine,
      editor: editor,
      from: from,
      to: to,
      text: text,
      before: doc.slice(Math.max(0, from - 48), from),
      after: doc.slice(to, Math.min(doc.length, to + 48)),
    }
    return savedSelection
  }

  function replacementTargetStillMatches(target, doc) {
    if (doc.slice(target.from, target.to) !== target.text) return false
    var beforeStart = Math.max(0, target.from - target.before.length)
    if (doc.slice(beforeStart, target.from) !== target.before) return false
    return doc.slice(target.to, target.to + target.after.length) === target.after
  }

  function selectionEditorIsAttached(target) {
    try {
      var node = target.engine === 'cm5' && target.editor && typeof target.editor.getWrapperElement === 'function'
        ? target.editor.getWrapperElement()
        : target.editor && (target.editor.dom || target.editor.scrollDOM)
      return !!node && document.documentElement.contains(node)
    } catch (err) {
      return false
    }
  }

  function replaceSavedEditorSelection(id, replacement) {
    if (!savedSelection || savedSelection.id !== id) {
      sendToParent({ type: 'selection-replace-done', ok: false, error: 'selection-expired' })
      return
    }
    var target = savedSelection
    try {
      if (target.engine === 'cm5') {
        var cm5 = target.editor
        var doc5 = cm5 && String(cm5.getValue())
        if (!cm5 || !selectionEditorIsAttached(target) || !replacementTargetStillMatches(target, doc5)) throw new Error('selection-stale')
        rememberSnapshot(doc5)
        cm5.replaceRange(replacement, cm5.posFromIndex(target.from), cm5.posFromIndex(target.to))
        cm5.setCursor(cm5.posFromIndex(target.from + replacement.length))
        cm5.focus()
      } else if (target.engine === 'cm6') {
        var cm6 = target.editor
        var doc6 = cm6 && cm6.state.doc.toString()
        if (!cm6 || !selectionEditorIsAttached(target) || !replacementTargetStillMatches(target, doc6)) throw new Error('selection-stale')
        rememberSnapshot(doc6)
        cm6.dispatch({
          changes: { from: target.from, to: target.to, insert: replacement },
          selection: { anchor: target.from + replacement.length },
        })
        cm6.focus()
      } else {
        throw new Error('selection-engine-unavailable')
      }
      savedSelection = undefined
      sendToParent({ type: 'selection-replace-done', ok: true, engine: target.engine })
    } catch (err) {
      sendToParent({ type: 'selection-replace-done', ok: false, error: err && err.message })
    }
  }

  function insertViaCm5(cm, text) {
    var snapshot = String(cm.getValue())
    rememberSnapshot(snapshot)
    cm.replaceSelection(text)
    cm.focus()
    return true
  }

  function insertViaCm6(view, text) {
    var state = view.state
    var snapshot = state.doc.toString()
    rememberSnapshot(snapshot)
    var from = state.selection.main.from
    var to = state.selection.main.to
    view.dispatch({ changes: { from: from, to: to, insert: text }, selection: { anchor: from + text.length } })
    view.focus()
    return true
  }

  function insertFallback(text) {
    var active = document.activeElement
    var editable = active && (active.tagName === 'TEXTAREA' || active.isContentEditable)
    if (editable && document.execCommand) {
      document.execCommand('insertText', false, text)
      return true
    }
    var holder = document.querySelector('.ace_text-input')
    if (holder) {
      holder.focus()
      if (document.execCommand) {
        document.execCommand('insertText', false, text)
        return true
      }
    }
    return false
  }

  /* ---------------------------------------------------------------- */
  /* Snapshot buffer (rollback)                                       */
  /* ---------------------------------------------------------------- */

  var SNAPSHOT_KEY = 'dsh-overleaf:snapshot'
  function readDocValue() {
    try {
      var cm5 = findCm5()
      if (cm5) return String(cm5.getValue())
      var cm6 = findCm6()
      if (cm6) return cm6.state.doc.toString()
      return undefined
    } catch (err) {
      return undefined
    }
  }

  /* Cursor context for AI prompts: the text around the caret plus the caret
     offset, so the agent can ground its edit in the real document. */
  function readCursorContext(radius) {
    try {
      var docValue = readDocValue()
      if (docValue === undefined) return undefined
      var text = String(docValue)
      var cursor = -1
      var cm5 = findCm5()
      if (cm5) {
        try { cursor = cm5.indexFromPos(cm5.getCursor()) } catch (err) { cursor = -1 }
      } else {
        var cm6 = findCm6()
        if (cm6) {
          try { cursor = cm6.state.selection.main.head } catch (err2) { cursor = -1 }
        }
      }
      if (cursor < 0) cursor = 0
      var r = Number(radius) || 1200
      var from = Math.max(0, cursor - r)
      var to = Math.min(text.length, cursor + r)
      return {
        cursor: cursor,
        docLength: text.length,
        before: text.slice(from, cursor),
        after: text.slice(cursor, to),
      }
    } catch (err) {
      return undefined
    }
  }
  function rememberSnapshot(docValue) {
    try {
      if (docValue === undefined || docValue === null) return
      window.localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({
        time: Date.now(),
        doc: docValue,
      }))
      sendToParent({ type: 'snapshot-saved' })
    } catch (err) {
      if (DEBUG) log('snapshot failed', err)
    }
  }

  /* ---------------------------------------------------------------- */
  /* Parent command handling                                          */
  /* ---------------------------------------------------------------- */

  window.addEventListener('message', safe(function (event) {
    if (event.source !== window.parent) return
    var data = event.data
    if (!data || data.ns !== NS) return
    if (data.type === 'insert') {
      try {
        var cm5 = findCm5()
        if (cm5) {
          insertViaCm5(cm5, String(data.text || ''))
          sendToParent({ type: 'insert-done', ok: true, engine: 'cm5' })
          return
        }
        var cm6 = findCm6()
        if (cm6) {
          insertViaCm6(cm6, String(data.text || ''))
          sendToParent({ type: 'insert-done', ok: true, engine: 'cm6' })
          return
        }
        var fellBack = insertFallback(String(data.text || ''))
        sendToParent({ type: 'insert-done', ok: !!fellBack, engine: fellBack ? 'fallback' : 'none',
          error: fellBack ? undefined : 'editor API not detected; paste manually from the reply' })
      } catch (err) {
        sendToParent({ type: 'insert-done', ok: false, error: err && err.message })
      }
      return
    }
    if (data.type === 'snapshot') {
      rememberSnapshot(readDocValue())
      return
    }
    if (data.type === 'selection-request') {
      emitSelection(true)
      return
    }
    if (data.type === 'replace-selection') {
      replaceSavedEditorSelection(String(data.selectionId || ''), String(data.text || ''))
      return
    }
    if (data.type === 'compile-log-request') {
      publishCompileLog()
      return
    }
    if (data.type === 'document-request') {
      try {
        var docText = readDocValue()
        if (docText === undefined) {
          sendToParent({ type: 'document', name: 'current-document', text: '', error: 'no-editor' })
          return
        }
        var fullDoc = String(docText)
        var cappedDoc = truncateText(fullDoc, 200000)
        sendToParent({
          type: 'document',
          name: currentDocName(),
          text: cappedDoc,
          truncated: cappedDoc.length < fullDoc.length,
        })
      } catch (err) {
        sendToParent({ type: 'document', name: 'current-document', text: '', error: err && err.message })
      }
      return
    }
    if (data.type === 'apply-fix-edits') {
      applyFixEdits(data.edits)
      return
    }
    if (data.type === 'recompile-click') {
      clickRecompile()
      return
    }
    if (data.type === 'reveal') {
      revealText(String(data.query || ''))
      return
    }
    if (data.type === 'outline-request') {
      sendOutline()
      return
    }
    if (data.type === 'cursor-context-request') {
      try {
        var cc = readCursorContext(data.radius)
        if (cc === undefined) {
          sendToParent({ type: 'cursor-context', error: 'no-editor' })
        } else {
          sendToParent({ type: 'cursor-context', cursor: cc.cursor, docLength: cc.docLength, before: cc.before, after: cc.after })
        }
      } catch (err) {
        sendToParent({ type: 'cursor-context', error: err && err.message })
      }
      return
    }
    if (data.type === 'debug') {
      DEBUG = true
      return
    }
  }, 'message handler'), false)

  /* Extract a LaTeX section/subsection outline from the live editor document. */
  function sendOutline() {
    try {
      var docValue = readDocValue()
      var cm5 = findCm5()
      var cm6 = cm5 ? undefined : findCm6()
      var engine = cm5 ? 'cm5' : (cm6 ? 'cm6' : 'none')
      var debug = { engine: engine, url: location.href }
      if (docValue === undefined) {
        sendToParent({ type: 'outline', items: [], error: 'no-editor', debug: debug })
        return
      }
      /* NOTE: inside this TS template literal every backslash that must
         survive into the generated JS is doubled (\\n, \\s, \\{). A single
         \n here becomes a REAL newline in the served script and breaks it. */
      var lines = String(docValue).split('\\n')
      var items = []
      /* Starred (unnumbered) sections are outline entries too. */
      var pattern = /^\\\\(part|chapter|section|subsection|subsubsection)\\*?\\s*\\{([^}]*)}/
      for (var i = 0; i < lines.length; i++) {
        var match = pattern.exec(lines[i])
        if (!match) continue
        items.push({
          level: match[1],
          title: match[2].trim(),
          line: i,
          text: lines[i],
        })
        if (items.length >= 300) break
      }
      debug.chars = String(docValue).length
      debug.hits = items.length
      sendToParent({ type: 'outline', items: items, debug: debug })
    } catch (err) {
      sendToParent({ type: 'outline', items: [], error: err && err.message })
    }
  }

  /* Report whether the caret insertion works right now (toolbar health). */
  function reportCapabilities() {
    var kind = 'none'
    if (findCm5()) kind = 'cm5'
    else if (findCm6()) kind = 'cm6'
    sendToParent({ type: 'capabilities', editor: kind })
  }
  setTimeout(safe(reportCapabilities, 'cap probe'), 1200)

  /* ---------------------------------------------------------------- */
  /* Selection reporting (R5 source side)                             */
  /* ---------------------------------------------------------------- */

  var lastSelectionSentAt = 0
  function emitSelection(force) {
    try {
      var editorSelection = captureEditorSelection()
      if (editorSelection) {
        var editorNow = Date.now()
        if (!force && editorNow - lastSelectionSentAt < 80) return
        lastSelectionSentAt = editorNow
        sendToParent({
          type: 'selection',
          text: editorSelection.text,
          selectionId: editorSelection.id,
          engine: editorSelection.engine,
          rect: { left: 0, top: 0, right: 0, bottom: 0 },
        })
        return
      }
      var sel = window.getSelection()
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
        sendToParent({ type: 'selection-cleared' })
        return
      }
      var text = sel.toString()
      if (!text.trim()) {
        sendToParent({ type: 'selection-cleared' })
        return
      }
      var now = Date.now()
      if (!force && now - lastSelectionSentAt < 80) return
      lastSelectionSentAt = now
      var range = sel.getRangeAt(0)
      var rect = { left: 0, top: 0, right: 0, bottom: 0 }
      try {
        var box = range.getBoundingClientRect()
        rect = { left: box.left, top: box.top, right: box.right, bottom: box.bottom }
      } catch (ignoredRectError) {}
      sendToParent({ type: 'selection', text: text, engine: 'dom', rect: rect })
    } catch (err) {
      if (DEBUG) log('selection emit failed', err)
    }
  }
  document.addEventListener('selectionchange', safe(function () { emitSelection(false) }, 'selectionchange'), true)
  document.addEventListener('keyup', safe(function () { emitSelection(false) }, 'keyup-selection'), true)

  /* ---------------------------------------------------------------- */
  /* Reveal + flash (chip jump-back target)                           */
  /* ---------------------------------------------------------------- */

  function revealText(query) {
    try {
      if (!query) return
      var needle = query.replace(/^\\n+|\\n+$/g, '').slice(0, 200)
      if (!needle) return
      var cm5 = findCm5()
      if (cm5) {
        var doc = String(cm5.getValue())
        var index = doc.indexOf(needle)
        if (index >= 0) {
          var from = cm5.posFromIndex(index)
          var to = cm5.posFromIndex(index + Math.min(needle.length, 400))
          cm5.setSelection(from, to)
          cm5.scrollIntoView({ from: from, to: to }, 160)
          cm5.focus()
          return
        }
      }
      /* DOM-wide soft match otherwise */
      var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false)
      while (walker.nextNode()) {
        var node = walker.currentNode
        if (node.nodeValue && node.nodeValue.indexOf(needle.slice(0, 60)) !== -1) {
          var parentEl = node.parentElement
          if (parentEl) {
            parentEl.scrollIntoView({ block: 'center', behavior: 'smooth' })
            var previousShadow = parentEl.style.boxShadow
            parentEl.style.boxShadow = '0 0 0 3px rgba(64,156,255,0.65)'
            setTimeout(function () { parentEl.style.boxShadow = previousShadow }, 1600)
            return
          }
        }
      }
    } catch (err) {
      if (DEBUG) log('reveal failed', err)
    }
  }

  /* Notify the shell whenever the embedded URL changes (toolbar breadcrumb). */
  function announceLocation() {
    sendToParent({ type: 'url-change', href: window.location.href })
  }
  announceLocation()
  window.addEventListener('popstate', safe(announceLocation, 'popstate'))

  /* ---------------------------------------------------------------- */
  /* Dynamic resource routing                                         */
  /*                                                                  */
  /* The proxy rewrites the INITIAL HTML server-side, but SPAs (TeXPage */
  /* dashboards, Overleaf loaders) insert scripts/styles/images at     */
  /* runtime with root-relative URLs; those would fall out of the      */
  /* proxy and hit the GUI shell's own fallback routes. Sweep existing */
  /* nodes once the DOM is ready, then watch every insertion/attribute */
  /* change and rebase matching URLs in place.                         */
  /* ---------------------------------------------------------------- */

  var RESOURCE_ATTRS = ['src', 'href', 'poster', 'data-src']
  function fixResourceNode(el) {
    try {
      if (!el || el.nodeType !== 1 || !el.hasAttribute) return
      for (var i = 0; i < RESOURCE_ATTRS.length; i++) {
        var attr = RESOURCE_ATTRS[i]
        if (!el.hasAttribute(attr)) continue
        var value = el.getAttribute(attr)
        if (typeof value !== 'string') continue
        if (value.indexOf('/overleaf/workbench/') === 0) continue
        var routed = routeUrl(value)
        if (routed !== value) el.setAttribute(attr, routed)
      }
    } catch (err) {
      if (DEBUG) log('fixResourceNode failed', err)
    }
  }
  try {
    var resourceObserver = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var mutation = mutations[i]
        if (mutation.type === 'attributes') {
          fixResourceNode(mutation.target)
          continue
        }
        for (var j = 0; j < mutation.addedNodes.length; j++) {
          var added = mutation.addedNodes[j]
          fixResourceNode(added)
          if (added && added.querySelectorAll) {
            var list = added.querySelectorAll('[src],[href],[poster],[data-src]')
            for (var k = 0; k < list.length; k++) fixResourceNode(list[k])
          }
        }
      }
    })
    function startResourceObserver() {
      if (!document.documentElement) {
        setTimeout(startResourceObserver, 50)
        return
      }
      resourceObserver.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: RESOURCE_ATTRS,
      })
    }
    startResourceObserver()
  } catch (err) {
    if (DEBUG) log('resource observer unavailable', err)
  }

  document.addEventListener('DOMContentLoaded', safe(function () {
    try {
      var list = document.querySelectorAll('[src],[href],[poster],[data-src]')
      for (var i = 0; i < list.length; i++) fixResourceNode(list[i])
    } catch (err) {
      if (DEBUG) log('initial sweep failed', err)
    }
    announceLocation()
    reportCapabilities()
  }, 'dom ready'))

  log('bridge ready')
})()
`;
}
//#endregion
//#region lib/types/service.js
/**
* dsh-overleaf host half: the Cordis Service mounted as the `overleaf-workbench`
* row of a web profile. Owns:
*  - `/overleaf-proxy/*` same-origin reverse proxy (HTTP prefix route) plus
*    exact WebSocket upgrade routes for socket.io;
*  - `/overleaf/workbench/*` JSON routes (status, login, cookie, logout,
*    projects) and the bridge script asset;
*  - the stored session-cookie credential feeding both.
*
* Route prefixes are deliberately disjoint from dsh-better-overleaf's
* `/overleaf/*` surface so the two plugins can coexist in one profile.
*/
/** Stable Cordis plugin name (the patch row `name:` must match package.json). */
const name = "overleaf-workbench";
/**
* Fixed workspace filename the agent is asked to write its final insert
* content into (see the AI-write flow). MUST match the constant in
* src/client/view.tsx. Reads are restricted to exactly this filename.
*/
const INSERT_FILE_NAME = "dsh-overleaf-insert.md";
/**
* Fixed workspace filename the agent writes its compile-fix edit list into
* (see the compile-fix panel flow). MUST match the constant in
* src/client/view.tsx; reads are restricted to exactly this filename.
*/
const FIX_FILE_NAME = "dsh-overleaf-fix.md";
/** Services required before the host plugin can mount. */
const inject = ["webServer", "credentials"];
const MAX_REQUEST_BYTES = 65536;
const LOOPBACK_ADDRESSES = /* @__PURE__ */ new Set([
	"127.0.0.1",
	"::1",
	"::ffff:127.0.0.1"
]);
function isLoopback(req) {
	return req.socket.remoteAddress === void 0 || LOOPBACK_ADDRESSES.has(req.socket.remoteAddress);
}
async function readJsonBody(req) {
	const chunks = [];
	let bytes = 0;
	for await (const chunk of req) {
		const buffer = chunk;
		bytes += buffer.byteLength;
		if (bytes > MAX_REQUEST_BYTES) throw new Error("dsh-overleaf: request body too large");
		chunks.push(buffer);
	}
	if (chunks.length === 0) return {};
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function sendJson(res, status, body) {
	if (res.headersSent) {
		res.destroy();
		return;
	}
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store"
	});
	res.end(JSON.stringify(body));
}
function sendError(res, error) {
	const message = error instanceof Error ? error.message : String(error);
	sendJson(res, 500, {
		ok: false,
		error: {
			code: error instanceof Error && error.name !== "Error" ? error.name : "dsh-overleaf-route-error",
			message
		}
	});
}
function stringField(payload, field) {
	if (typeof payload !== "object" || payload === null) return void 0;
	const value = payload[field];
	return typeof value === "string" ? value : void 0;
}
/** The `ctx.overleafWorkbench` service. */
var OverleafWorkbenchService = class extends Service {
	static inject = [
		"webServer",
		"credentials",
		"settings"
	];
	static Config = Config;
	/** Mutable because live settings updates swap it wholesale. */
	config;
	proxy;
	bridgeScript;
	/** Background CDP login bookkeeping (client polls /login-status). */
	loginRunning = false;
	loginStartedAt = 0;
	loginResult;
	loginError;
	constructor(ctx, config) {
		super(ctx, "overleaf-workbench");
		this.config = resolveConfig(config);
		this.mountBaseConfig = { ...config };
		this.proxy = new ReverseProxy(this.config.baseUrl);
		this.bridgeScript = renderBridgeScript();
		this.proxy.injectScriptSrc = this.config.injectScriptEnabled ? "/overleaf/workbench/bridge.js" : void 0;
		this.refreshCredential().catch((error) => ctx.logger?.warn?.(`dsh-overleaf: credential probe failed: ${error instanceof Error ? error.message : String(error)}`));
		this.registerRoutes();
		this.registerSettingsNamespace();
		this.startWsTunnel();
	}
	/**
	* Companion WS tunnel on its OWN loopback port. The DSH webserver's upgrade
	* registry is exact-path-only and socket.io's upgrade paths carry dynamic
	* session ids (`/socket.io/<sid>/websocket/<t>`), which can never match.
	* The bridge redirects the embedded site's WebSocket connections to this
	* port, where every upgrade path is tunneled verbatim to the upstream.
	*/
	startWsTunnel() {
		const server = http.createServer((_request, response) => {
			this.destroySafely(response);
		});
		server.on("upgrade", (req, socket, head) => {
			if (!isLoopback(req)) {
				socket.destroy();
				return;
			}
			this.proxy.tunnelUpgrade(req, socket, head);
		});
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address !== null ? address.port : 0;
			if (port > 0) {
				this.proxy.wsPort = port;
				this.proxy.wsAllowOrigin = `ws://127.0.0.1:${port} wss://127.0.0.1:${port}`;
			}
		});
		this.ctx.effect(() => () => {
			server.close();
			server.closeAllConnections?.();
		}, "dsh-overleaf: ws tunnel server");
	}
	/** Port of the companion WS tunnel (0 until listening; tests may read it). */
	get wsTunnelPort() {
		return this.proxy.wsPort;
	}
	destroySafely(response) {
		try {
			response.writeHead(404);
			response.end();
		} catch {}
	}
	/** Base layer handed to the settings service (the composed mount config). */
	mountBaseConfig;
	/**
	* Publish the `dsh-overleaf` settings namespace so the Plugins settings page
	* can own baseUrl/feature toggles without hand-editing the profile row.
	* Composed patch values become the namespace `base`; user edits layer above
	* them. Live changes hot-swap the proxy target — no restart required. The
	* whole feature degrades silently when the profile runs no settings service.
	*/
	registerSettingsNamespace() {
		const settings = this.ctx.settings;
		if (settings?.register === void 0) return;
		try {
			const scope = settings.register("dsh-overleaf", Config, { base: this.mountBaseConfig ?? {} });
			this.ctx.effect(() => scope.watch((next) => {
				try {
					if (next !== void 0) this.applyRuntimeConfig(resolveConfig(next));
				} catch (error) {
					console.warn("[dsh-overleaf] settings application failed:", error instanceof Error ? error.message : error);
				}
			}), "dsh-overleaf: settings watcher");
			const seeded = scope.get();
			if (seeded !== void 0) this.applyRuntimeConfig(resolveConfig(seeded));
		} catch (error) {
			console.warn("[dsh-overleaf] settings namespace skipped:", error instanceof Error ? error.message : error);
		}
	}
	/** Swap runtime behavior after a settings commit (hot reload of the proxy). */
	applyRuntimeConfig(next) {
		const staleCookie = this.proxy.extraCookie;
		const wsPort = this.proxy.wsPort;
		const wsAllowOrigin = this.proxy.wsAllowOrigin;
		this.config = next;
		this.proxy = new ReverseProxy(next.baseUrl);
		this.proxy.extraCookie = staleCookie;
		this.proxy.injectScriptSrc = next.injectScriptEnabled ? "/overleaf/workbench/bridge.js" : void 0;
		this.proxy.wsPort = wsPort;
		this.proxy.wsAllowOrigin = wsAllowOrigin;
	}
	/** Push the latest stored cookie into the proxy (re-read on every change). */
	async refreshCredential() {
		try {
			const resolved = await this.ctx.credentials.resolve(OVERLEAF_WORKBENCH_COOKIE);
			this.proxy.extraCookie = resolved?.value;
		} catch {
			this.proxy.extraCookie = void 0;
		}
	}
	/** Register one exact JSON route with the shared envelope contract. */
	route(path, run) {
		this.ctx.effect(() => this.ctx.webServer.register({
			kind: "exact",
			path,
			handler: async (req, res) => {
				if (!isLoopback(req)) {
					sendJson(res, 403, {
						ok: false,
						error: {
							code: "dsh-overleaf-loopback-only",
							message: "workbench routes are loopback-only"
						}
					});
					return;
				}
				try {
					sendJson(res, 200, {
						ok: true,
						value: await run(await readJsonBody(req) ?? {})
					});
				} catch (error) {
					sendError(res, error);
				}
			}
		}), `dsh-overleaf: route ${path}`);
	}
	registerRoutes() {
		this.route("/overleaf/workbench/status", () => this.status());
		this.route("/overleaf/workbench/login", async (payload) => {
			if (this.loginRunning) return { kind: "pending" };
			const browserChannel = stringField(payload, "browserChannel");
			const channel = browserChannel !== void 0 && [
				"auto",
				"default",
				"msedge",
				"chrome",
				"real"
			].includes(browserChannel) ? browserChannel : void 0;
			const browserPath = stringField(payload, "browserPath");
			this.loginRunning = true;
			this.loginStartedAt = Date.now();
			this.loginResult = void 0;
			this.loginError = void 0;
			this.login(channel, browserPath).then(async (result) => {
				this.loginResult = result;
				await this.refreshCredential();
			}).catch((error) => {
				this.loginError = error instanceof Error ? error.message : String(error);
			}).finally(() => {
				this.loginRunning = false;
				this.refreshCredential().catch(() => void 0);
			});
			return { kind: "started" };
		});
		this.route("/overleaf/workbench/login-status", async () => ({
			running: this.loginRunning,
			elapsedMs: this.loginRunning ? Date.now() - this.loginStartedAt : 0,
			...this.loginResult !== void 0 ? { result: this.loginResult } : {},
			...this.loginError !== void 0 ? { error: this.loginError } : {}
		}));
		this.route("/overleaf/workbench/cookie", async (payload) => {
			const cookie = stringField(payload, "cookie");
			if (cookie === void 0 || cookie.trim() === "") throw new Error("dsh-overleaf: cookie route requires a non-empty cookie header line");
			await this.saveCookie(cookie.trim());
			await this.refreshCredential();
			return { saved: true };
		});
		this.route("/overleaf/workbench/logout", async () => {
			await this.ctx.credentials.unset(OVERLEAF_WORKBENCH_COOKIE);
			await this.refreshCredential();
			return { cleared: true };
		});
		this.route("/overleaf/workbench/projects", () => this.listProjects());
		this.route("/overleaf/workbench/embed-info", async () => ({
			baseUrl: this.config.baseUrl,
			embedUrl: `${PROXY_PREFIX}/`,
			selectionQuoteEnabled: this.config.selectionQuoteEnabled,
			cursorInsertEnabled: this.config.cursorInsertEnabled,
			assistPanelEnabled: this.config.assistPanelEnabled
		}));
		this.route("/overleaf/workbench/read-insert-file", async (payload) => {
			const cwd = stringField(payload, "cwd");
			if (cwd === void 0 || cwd.trim() === "" || !isAbsolute(cwd.trim())) throw new Error("dsh-overleaf: read-insert-file requires an absolute cwd");
			const target = join(cwd.trim(), INSERT_FILE_NAME);
			const stats = await stat(target).catch(() => void 0);
			if (stats === void 0 || !stats.isFile()) return { exists: false };
			return {
				exists: true,
				content: await readFile(target, "utf8"),
				mtimeMs: stats.mtimeMs
			};
		});
		this.route("/overleaf/workbench/read-fix-file", async (payload) => {
			const cwd = stringField(payload, "cwd");
			if (cwd === void 0 || cwd.trim() === "" || !isAbsolute(cwd.trim())) throw new Error("dsh-overleaf: read-fix-file requires an absolute cwd");
			const target = join(cwd.trim(), FIX_FILE_NAME);
			const stats = await stat(target).catch(() => void 0);
			if (stats === void 0 || !stats.isFile()) return { exists: false };
			return {
				exists: true,
				content: await readFile(target, "utf8"),
				mtimeMs: stats.mtimeMs
			};
		});
		this.ctx.effect(() => this.ctx.webServer.register({
			kind: "exact",
			path: "/overleaf/workbench/bridge.js",
			handler: (req, res) => {
				if (!isLoopback(req)) {
					res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
					res.end("forbidden: loopback-only");
					return;
				}
				res.writeHead(200, {
					"content-type": "text/javascript; charset=utf-8",
					"cache-control": "no-store"
				});
				res.end(this.bridgeScript);
			}
		}), "dsh-overleaf: bridge script");
		this.ctx.effect(() => this.ctx.webServer.register({
			kind: "prefix",
			path: PROXY_PREFIX,
			handler: async (req, res) => {
				if (!isLoopback(req)) {
					sendJson(res, 403, {
						ok: false,
						error: {
							code: "dsh-overleaf-loopback-only",
							message: "proxy routes are loopback-only"
						}
					});
					return;
				}
				await this.proxy.handle(req, res);
			}
		}), "dsh-overleaf: reverse proxy");
		for (const wsPath of [
			"/overleaf-proxy/socket.io/",
			"/overleaf-proxy/socket.io",
			"/socket.io/",
			"/socket.io"
		]) this.ctx.effect(() => this.ctx.webServer.registerUpgrade({
			path: wsPath,
			handler: (req, socket, head) => {
				if (!isLoopback(req)) {
					socket.destroy();
					return;
				}
				this.proxy.tunnelUpgrade(req, socket, head);
			}
		}), `dsh-overleaf: upgrade ${wsPath}`);
		this.ctx.effect(() => this.ctx.webServer.register({
			kind: "prefix",
			path: "/socket.io",
			handler: async (req, res) => {
				if (!isLoopback(req)) {
					sendJson(res, 403, {
						ok: false,
						error: {
							code: "dsh-overleaf-loopback-only",
							message: "proxy routes are loopback-only"
						}
					});
					return;
				}
				await this.proxy.handle(req, res);
			}
		}), "dsh-overleaf: socket.io polling alias");
	}
	/** Read current account state plus embed descriptors for the toolbar. */
	async status() {
		let loggedIn = false;
		try {
			loggedIn = (await this.ctx.credentials.describe(OVERLEAF_WORKBENCH_COOKIE)).configured;
		} catch {
			loggedIn = false;
		}
		return {
			loggedIn,
			baseUrl: this.config.baseUrl,
			embedUrl: `${PROXY_PREFIX}/`,
			proxyReady: true,
			assistPanelEnabled: this.config.assistPanelEnabled
		};
	}
	/** Log in through direct CDP against the configured upstream origin. */
	async login(browserChannel, browserPath) {
		const target = new URL(this.config.baseUrl);
		return await loginViaCdp(this.ctx.credentials, {
			loginUrl: `${this.config.baseUrl}/login`,
			targetHost: target.hostname,
			baseUrl: this.config.baseUrl,
			projectUrlPrefix: `${this.config.baseUrl}/project`,
			browserChannel: browserChannel ?? this.config.browserChannel,
			...browserPath !== void 0 && browserPath.trim() !== "" ? { browserPath: browserPath.trim() } : this.config.browserPath !== void 0 ? { browserPath: this.config.browserPath } : {},
			...this.config.loginProxyServer !== void 0 ? { loginProxyServer: this.config.loginProxyServer } : {},
			timeoutMs: this.config.loginTimeoutMs,
			profileMode: this.config.loginProfile
		});
	}
	/**
	* Store a cookie header line after a tolerant upstream check. The check
	* accepts standard Overleaf (200 on /project) and TeXPage-style deployments
	* (dashboard redirect away from /login); see cookie-validate.ts.
	*/
	async saveCookie(cookie) {
		await validateCookieHeader(cookie, this.config.baseUrl);
		await this.ctx.credentials.set(OVERLEAF_WORKBENCH_COOKIE, cookie);
	}
	/** List projects through dashboard JSON APIs, falling back to HTML scraping. */
	async listProjects(signal) {
		const cookieResolves = await this.ctx.credentials.resolve(OVERLEAF_WORKBENCH_COOKIE).catch(() => void 0);
		if (cookieResolves === void 0) throw new Error("dsh-overleaf: OVERLEAF_WORKBENCH_COOKIE is not configured; log in first");
		const failures = [];
		for (const path of [
			"/api/project",
			"/api/projects",
			"/api/v2/projects"
		]) try {
			const response = await fetch(`${this.config.baseUrl}${path}`, {
				headers: {
					cookie: cookieResolves.value,
					accept: "application/json",
					referer: `${this.config.baseUrl}/project`
				},
				...signal !== void 0 ? { signal } : {}
			});
			if (!response.ok) {
				failures.push(`${path}: HTTP ${response.status}`);
				continue;
			}
			const projects = projectsFromUnknown(await response.json());
			if (projects.length > 0) return projects;
			failures.push(`${path}: no recognizable entries`);
		} catch (error) {
			failures.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
		}
		try {
			const scraped = projectsFromDashboardHtml(await fetch(`${this.config.baseUrl}/project`, {
				headers: {
					cookie: cookieResolves.value,
					accept: "text/html"
				},
				...signal !== void 0 ? { signal } : {}
			}).then((response) => response.text()));
			if (scraped.length > 0) return scraped;
			failures.push("/project: dashboard contained no project links");
		} catch (error) {
			failures.push(`/project: ${error instanceof Error ? error.message : String(error)}`);
		}
		throw new Error(`dsh-overleaf: could not list projects (${failures.join("; ")})`);
	}
};
/** Normalize heterogeneous project JSON shapes into wire rows. */
function projectsFromUnknown(value) {
	const array = Array.isArray(value) ? value : typeof value === "object" && value !== null && Array.isArray(value.projects) ? value.projects : [];
	const out = [];
	for (const item of array) {
		if (typeof item !== "object" || item === null) continue;
		const raw = item;
		const id = typeof raw._id === "string" ? raw._id : typeof raw.id === "string" ? raw.id : void 0;
		if (id === void 0) continue;
		const name = typeof raw.name === "string" && raw.name !== "" ? raw.name : id;
		const lastUpdated = typeof raw.lastUpdated === "string" ? raw.lastUpdated : void 0;
		out.push({
			id,
			name,
			...lastUpdated !== void 0 ? { lastUpdated } : {}
		});
	}
	return out;
}
/** Scrape `<a href="/project/<24hex>">` rows out of a dashboard HTML page. */
function projectsFromDashboardHtml(html) {
	const out = [];
	const seen = /* @__PURE__ */ new Set();
	const pattern = /<a\b[^>]*\bhref=["']\/project\/([0-9a-fA-F]{24})["'][^>]*>([\s\S]*?)<\/a>/gi;
	let match = pattern.exec(html);
	while (match !== null) {
		const id = match[1];
		const inner = match[2] ?? "";
		if (id !== void 0 && !seen.has(id)) {
			seen.add(id);
			const text = inner.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
			out.push({
				id,
				name: text !== "" ? text : id
			});
		}
		match = pattern.exec(html);
	}
	return out;
}
//#endregion
export { BRIDGE_SCRIPT_NAME, Config, OVERLEAF_WORKBENCH_COOKIE, OverleafWorkbenchService, OverleafWorkbenchService as default, PROXY_PREFIX, ReverseProxy, allowSelfInCsp, buildUpstreamHeaders, extractContentDomainFromHtml, extractContentHintsFromJson, extractCspNonce, inject, loginViaCdp, mergeCookieHeaders, mergeProxyCookieHeaders, name, normalizeOrigin, persistentLoginProfileDir, projectsFromDashboardHtml, relaxFrameCsp, renderBridgeScript, requestTimeoutFor, resolveConfig, rewriteCss, rewriteHtml, scopeSetCookieToHost, subPathOf };
