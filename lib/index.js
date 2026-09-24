import { Service } from "@deepseek-ai/cordis";
import http from "node:http";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
* the profile row and, from DSH 0.1.7 on, live-editable from the Plugins page:
* dsh-settings projects a form from the schema's `.volatile()` fields alone
* (`volatileForm` omits an entry with none), keeps those values in a live
* reference the Loader mutates in place, and re-emits `loader/volatile-update`
* on the owning fiber instead of remounting the plugin. Reading a field
* therefore always goes through {@link readField}. Credentials never appear here.
*/
/** Structural test for a live reference — importing cosmokit is not required. */
function isVolatileRef(value) {
	return typeof value === "object" && value !== null && typeof value.get === "function";
}
/**
* Read one configuration field. Volatile fields arrive as live references and
* must be sampled per use; plain values (older harness generations, hand-edited
* patches) pass through unchanged.
*/
function readField(value) {
	return isVolatileRef(value) ? value.get() : value;
}
/** Default upstream: the public Overleaf cloud (user decision, v0.1.3). */
const DEFAULT_BASE_URL = "https://www.overleaf.com";
const DEFAULT_LOGIN_TIMEOUT_MS = 6e5;
/**
* Every field is `.volatile()`: that is what makes this plugin's row appear in
* the settings forms (an entry without one is skipped entirely) and what lets a
* save apply live instead of remounting the plugin.
*/
const Config = z.object({
	baseUrl: z.string().default(DEFAULT_BASE_URL).volatile(),
	browserChannel: z.union([
		z.const("auto"),
		z.const("default"),
		z.const("msedge"),
		z.const("chrome"),
		z.const("real")
	]).default("auto").volatile(),
	browserPath: z.string().volatile(),
	loginProxyServer: z.string().volatile(),
	loginTimeoutMs: z.natural().default(DEFAULT_LOGIN_TIMEOUT_MS).volatile(),
	loginProfile: z.union([z.const("persistent"), z.const("temporary")]).default("persistent").volatile(),
	selectionQuoteEnabled: z.boolean().default(true).volatile(),
	cursorInsertEnabled: z.boolean().default(true).volatile(),
	injectScriptEnabled: z.boolean().default(true).volatile(),
	assistPanelEnabled: z.boolean().default(true).volatile()
});
/**
* Apply defaults in the owning implementation, never hidden inside methods.
* Every field is sampled through {@link readField} so a live (volatile)
* reference reports its current value instead of the reference object.
*/
function resolveConfig(config) {
	const channel = readField(config.browserChannel) ?? "auto";
	const browserPathRaw = readField(config.browserPath);
	const browserPath = browserPathRaw !== void 0 && browserPathRaw.trim() !== "" ? browserPathRaw.trim() : void 0;
	const loginProxyServerRaw = readField(config.loginProxyServer);
	const loginProxyServer = loginProxyServerRaw !== void 0 && loginProxyServerRaw.trim() !== "" ? normalizeProxyServer(loginProxyServerRaw) : void 0;
	return {
		baseUrl: normalizeOrigin(readField(config.baseUrl) ?? DEFAULT_BASE_URL),
		browserChannel: channel,
		...browserPath !== void 0 ? { browserPath } : {},
		...loginProxyServer !== void 0 ? { loginProxyServer } : {},
		loginTimeoutMs: readField(config.loginTimeoutMs) ?? DEFAULT_LOGIN_TIMEOUT_MS,
		loginProfile: readField(config.loginProfile) ?? "persistent",
		selectionQuoteEnabled: readField(config.selectionQuoteEnabled) ?? true,
		cursorInsertEnabled: readField(config.cursorInsertEnabled) ?? true,
		injectScriptEnabled: readField(config.injectScriptEnabled) ?? true,
		assistPanelEnabled: readField(config.assistPanelEnabled) ?? true
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
* capture loop. A missing Overleaf /project route can fall back to the root
* (for example, TeXPage redirects it to /console), but only an authenticated
* page that is demonstrably protected from anonymous access proves login.
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
	"cdn_sec_tc",
	"gclb",
	"route",
	"serverid",
	"visitor_id",
	"visitorid",
	"visitor",
	"tracking_id",
	"cookieconsent",
	"cookie_consent",
	"optanonconsent",
	"optanonalertboxclosed"
]);
/** Whether one cookie plausibly carries a session. */
function isSessionishCookie(name, value) {
	const lower = name.toLowerCase();
	if (PREFERENCE_COOKIES.has(lower)) return false;
	if (/^_?(?:csrf|xsrf)|(?:^|[_-])(?:csrf|xsrf)(?:$|[_-])/.test(lower)) return false;
	if (/^_(?:ga(?:_|$)|gid$|gat|gcl_|hj|clck$|clsk$|fbp$|fbc$)|^(?:__utm|__cf|cf_clearance$|awsalb|amplitude_|amp_|mp_)/.test(lower)) return false;
	if (lower === "sessionid" || lower === "overleaf_session2") return value.trim() !== "";
	return value.trim().length >= 8;
}
/** Whether a redirect Location points at a login/SSO surface. */
function locationLooksLikeLogin(location) {
	if (location === "") return false;
	return /(?:^|[/?.])(?:login|signin|sign-in|sign_in|signon|sign-on|sign_on|sso|oauth2?|oidc|saml|authorize|auth|cas|ids)(?:$|[/?#&])|login\.[a-z]/i.test(location);
}
const MAX_REDIRECTS = 5;
const MAX_HTML_BYTES = 1048576;
const REDIRECT_STATUSES = /* @__PURE__ */ new Set([
	301,
	302,
	303,
	307,
	308
]);
/** Validate before fetching: manual redirects must never disclose the header. */
function sameOriginUrl(value, relativeTo, origin) {
	const url = new URL(value, relativeTo);
	if (!["http:", "https:"].includes(url.protocol) || url.origin !== origin || url.username !== "" || url.password !== "") throw new Error("dsh-overleaf: cookie verification refused an external or unsafe URL");
	url.hash = "";
	return url;
}
/** Bound response size as well as the shared request deadline. */
async function readHtml(response) {
	const reader = response.body?.getReader();
	if (reader === void 0) return "";
	const decoder = new TextDecoder();
	let bytes = 0;
	let html = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) return html + decoder.decode();
			bytes += value.byteLength;
			if (bytes > MAX_HTML_BYTES) {
				await reader.cancel();
				throw new Error("dsh-overleaf: cookie verification page exceeded the size limit");
			}
			html += decoder.decode(value, { stream: true });
		}
	} finally {
		reader.releaseLock();
	}
}
/** Ignore inert templates in comments/scripts when looking for login forms. */
function formsIn(html) {
	return html.replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "").match(/<form\b[^>]*>[\s\S]*?<\/form\s*>/gi) ?? [];
}
function hasPasswordForm(html) {
	return formsIn(html).some((form) => /<input\b[^>]*\btype\s*=\s*(?:"password"|'password'|password(?=[\s/>]))/i.test(form));
}
function isLoginPage(html) {
	return hasPasswordForm(html) || formsIn(html).some((form) => {
		const action = /^<form\b[^>]*\baction\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(form);
		return action !== null && locationLooksLikeLogin(action[1] ?? action[2] ?? action[3] ?? "");
	});
}
/** Walk only same-origin redirects; callers interpret login/denial by context. */
async function probe(start, origin, cookie, signal) {
	let url = start;
	const seen = /* @__PURE__ */ new Set();
	for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
		if (seen.has(url.href)) throw new Error("dsh-overleaf: cookie verification redirect loop");
		seen.add(url.href);
		if (locationLooksLikeLogin(url.pathname)) return { kind: "login" };
		const response = await fetch(url, {
			headers: {
				...cookie === void 0 ? {} : { cookie },
				accept: "text/html"
			},
			redirect: "manual",
			credentials: "omit",
			cache: "no-store",
			signal
		});
		if (response.status === 200) return {
			kind: "page",
			url,
			html: await readHtml(response)
		};
		await response.body?.cancel();
		if (response.status === 404) return { kind: "missing" };
		if (response.status === 401 || response.status === 403) return { kind: "denied" };
		if (!REDIRECT_STATUSES.has(response.status)) throw new Error(`dsh-overleaf: cookie verification received HTTP ${response.status}`);
		const location = response.headers.get("location");
		if (location === null || location.trim() === "") throw new Error("dsh-overleaf: cookie verification redirect has no Location");
		url = sameOriginUrl(location, url, origin);
	}
	throw new Error("dsh-overleaf: cookie verification exceeded the redirect limit");
}
/**
* Verify /project or an observed same-origin landing URL, falling back to the
* origin root only when the first route is missing. The final authenticated
* response must be 200 and not a login form; the same URL without cookies must
* redirect to login/SSO, deny access (401/403), or show a password form.
* Public HTML, arbitrary 404s and external redirects never prove authentication.
* One timeout bounds all requests, including redirects and the anonymous probe.
*/
async function validateCookieHeader(cookie, baseUrl, timeoutMs = 15e3, landingUrl) {
	if (cookie.trim() === "") throw new Error("dsh-overleaf: cookie verification requires a nonempty header");
	const base = new URL(baseUrl);
	const root = sameOriginUrl("/", base, base.origin);
	const first = sameOriginUrl(landingUrl ?? "/project", root, base.origin);
	const signal = AbortSignal.timeout(timeoutMs);
	let authenticated = await probe(first, base.origin, cookie, signal);
	if (authenticated.kind === "missing" && first.href !== root.href) authenticated = await probe(root, base.origin, cookie, signal);
	if (authenticated.kind !== "page" || isLoginPage(authenticated.html)) throw new Error("dsh-overleaf: cookie verification did not reach an authenticated page (missing route, login, or access denied)");
	const anonymous = await probe(authenticated.url, base.origin, void 0, signal);
	if (anonymous.kind === "denied" || anonymous.kind === "login" || anonymous.kind === "page" && hasPasswordForm(anonymous.html)) return;
	throw new Error("dsh-overleaf: cookie verification found no protected-page evidence; public or unverifiable pages do not prove login");
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
/** Match the cookie's actual host scope, not arbitrary child hosts. */
function cookieDomainMatchesHost(domain, host) {
	const normalizedDomain = domain.toLowerCase();
	const normalizedHost = host.toLowerCase();
	const bareDomain = normalizedDomain.replace(/^\./, "");
	return bareDomain !== "" && (normalizedHost === bareDomain || normalizedDomain.startsWith(".") && normalizedHost.endsWith(`.${bareDomain}`));
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
*  3. server-side validation of a protected landing page. A missing /project
*     route is not login proof; alternative dashboards are reached via /.
*/
async function captureCookies(browserCdp, cdpPort, options, timeoutMs) {
	const origin = new URL(options.baseUrl).origin;
	const deadline = Date.now() + timeoutMs;
	let cookieCdp = browserCdp;
	let pageCdp;
	try {
		while (Date.now() < deadline) {
			try {
				const siteCookies = (await readCookiesFrom(cookieCdp)).filter((cookie) => cookieDomainMatchesHost(cookie.domain, options.targetHost));
				if (siteCookies.filter((cookie) => isSessionishCookie(cookie.name, cookie.value)).length > 0) {
					const header = siteCookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
					let landingUrls = [];
					try {
						landingUrls = (await pageTargetUrls(cdpPort)).filter((url) => {
							try {
								const target = new URL(url);
								return target.origin === origin && !locationLooksLikeLogin(target.pathname);
							} catch {
								return false;
							}
						});
					} catch {
						landingUrls = [];
					}
					for (const landingUrl of [...new Set(landingUrls)].slice(0, 3)) try {
						await validateCookieHeader(header, options.baseUrl, Math.min(8e3, Math.max(1, deadline - Date.now())), landingUrl);
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
//#region lib/types/texpage-compat.js
const ASSET_PATH = "/__dsh_texpage_v1__/";
const ASSET_FILE = /^console\.[a-f0-9]{8,64}\.js$/i;
const CDN = "https://static.texpage.com";
const MAX_ASSET_BYTES = 4194304;
/** Only this fixed public CDN's console bundle is proxied, never arbitrary URLs. */
function texpageAssetUrl(subPath) {
	if (!subPath.startsWith(ASSET_PATH)) return void 0;
	const file = subPath.slice(20);
	return ASSET_FILE.test(file) ? new URL(`/dist/${file}`, CDN) : void 0;
}
function rewriteTexpageScriptTags(html, prefix) {
	return html.replace(/<script\b[^>]*>/gi, (tag) => {
		const src = /\bsrc\s*=\s*(["'])(.*?)\1/i.exec(tag);
		if (src === null) return tag;
		let url;
		if (!/^(?:https:\/\/|\/\/)static\.texpage\.com\//i.test(src[2] ?? "")) return tag;
		try {
			url = new URL(src[2] ?? "", CDN);
		} catch {
			return tag;
		}
		const file = url.pathname.slice(6);
		if (url.origin !== CDN || !url.pathname.startsWith("/dist/") || !ASSET_FILE.test(file) || url.search !== "" || url.username !== "" || url.password !== "") return tag;
		return tag.replace(src[0], `src="${prefix}${ASSET_PATH}${file}"`).replace(/\s+integrity\s*=\s*(?:"[^"]*"|'[^']*')/gi, "");
	});
}
/** BrowserRouter otherwise renders null at /overleaf-proxy/console, without errors. */
function rewriteTexpageConsoleScript(script, prefix) {
	let count = 0;
	const rewritten = script.replace(/\bbasename\s*:\s*(["'])\/console\1/g, () => {
		count++;
		return `basename:${JSON.stringify(`${prefix}/console`)}`;
	});
	if (count !== 1) throw new Error("dsh-overleaf: TeXPage console router format changed; compatibility update required");
	return rewritten.replace(/\/\/# sourceMappingURL=[^\r\n]*/g, "");
}
/** Bounded public-asset fetch. Never forward the user's cookies or other headers. */
async function serveTexpageConsoleAsset(req, res, url, prefix) {
	if (req.method !== "GET" && req.method !== "HEAD") {
		res.writeHead(405, { allow: "GET, HEAD" });
		res.end();
		return;
	}
	try {
		const response = await fetch(url, {
			redirect: "error",
			credentials: "omit",
			signal: AbortSignal.timeout(2e4),
			headers: { accept: "application/javascript" }
		});
		if (!response.ok || !/(?:java|ecma)script/i.test(response.headers.get("content-type") ?? "")) {
			await response.body?.cancel();
			throw new Error(`dsh-overleaf: TeXPage console asset unavailable (HTTP ${response.status})`);
		}
		const reader = response.body?.getReader();
		if (reader === void 0) throw new Error("dsh-overleaf: empty TeXPage console asset");
		const chunks = [];
		let size = 0;
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				size += value.byteLength;
				if (size > MAX_ASSET_BYTES) {
					await reader.cancel();
					throw new Error("dsh-overleaf: TeXPage console asset exceeds size limit");
				}
				chunks.push(value);
			}
		} finally {
			reader.releaseLock();
		}
		const payload = Buffer.from(rewriteTexpageConsoleScript(Buffer.concat(chunks).toString("utf8"), prefix));
		res.writeHead(200, {
			"content-type": "application/javascript; charset=utf-8",
			"content-length": String(payload.byteLength),
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
			"x-dsh-texpage-compat": "console-basename-v1"
		});
		res.end(req.method === "HEAD" ? void 0 : payload);
	} catch (error) {
		res.writeHead(502, {
			"content-type": "text/plain; charset=utf-8",
			"cache-control": "no-store"
		});
		res.end(error instanceof Error ? error.message : "dsh-overleaf: TeXPage compatibility asset failed");
	}
}
const MAX_HTML_CHARS = 4194304;
const MAX_CONFIG_CHARS = 65536;
const MAX_CONFIG_DEPTH = 64;
const ASSIGNMENT = /^window\s*\.\s*_domainConf\s*=\s*/;
/** Skip a JS string/template without interpreting escapes or interpolations. */
function quotedEnd(text, start) {
	const quote = text[start];
	for (let i = start + 1; i < text.length; i++) if (text[i] === "\\") i++;
	else if (text[i] === quote) return i + 1;
	return text.length;
}
/** Find the end of a bounded JSON object; JSON.parse validates its contents. */
function jsonObjectEnd(text, start) {
	if (text[start] !== "{") return void 0;
	let depth = 0;
	let quoted = false;
	let escaped = false;
	const limit = Math.min(text.length, start + MAX_CONFIG_CHARS);
	for (let i = start; i < limit; i++) {
		const char = text[i];
		if (quoted) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === "\"") quoted = false;
			continue;
		}
		if (char === "\"") quoted = true;
		else if (char === "{" || char === "[") {
			if (++depth > MAX_CONFIG_DEPTH) return void 0;
		} else if (char === "}" || char === "]") {
			if (--depth === 0) return i + 1;
		}
	}
}
/**
* Read one inline window._domainConf = { JSON } assignment, never executing JS.
* This only parses bounded data; callers must validate the fields they trust.
* Multiple assignments (including across scripts) fail closed.
*/
function readTexpageDomainConfig(html) {
	if (html.length > MAX_HTML_CHARS) return void 0;
	let found;
	const markup = html.replace(/<!--[\s\S]*?-->/g, "");
	for (const script of markup.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
		if (/(?:^|\s)src\s*=/i.test(script[1] ?? "")) continue;
		const body = script[2] ?? "";
		for (let i = 0; i < body.length;) {
			const char = body[i];
			if (char === "\"" || char === "'" || char === "`") {
				i = quotedEnd(body, i);
				continue;
			}
			if (body.startsWith("//", i)) {
				const end = body.indexOf("\n", i + 2);
				i = end < 0 ? body.length : end + 1;
				continue;
			}
			if (body.startsWith("/*", i)) {
				const end = body.indexOf("*/", i + 2);
				i = end < 0 ? body.length : end + 2;
				continue;
			}
			const assignment = body.startsWith("window", i) && !/[\w$./]/.test(body[i - 1] ?? "") ? ASSIGNMENT.exec(body.slice(i)) : null;
			if (assignment === null) {
				i++;
				continue;
			}
			if (found !== void 0) return void 0;
			const start = i + assignment[0].length;
			const end = jsonObjectEnd(body, start);
			if (end === void 0 || !/^\s*(?:;|$)/.test(body.slice(end))) return void 0;
			let config;
			try {
				config = JSON.parse(body.slice(start, end));
			} catch {
				return;
			}
			if (config === null || typeof config !== "object" || Array.isArray(config)) return void 0;
			found = config;
			i = end;
		}
	}
	return found;
}
/** Trust only the exact socket.<page hostname without leading www.> authority. */
function extractTexpageSocketOrigin(html, pageOrigin) {
	let page;
	try {
		page = new URL(String(pageOrigin));
	} catch {
		return;
	}
	if (!["http:", "https:"].includes(page.protocol) || page.username !== "" || page.password !== "" || page.port !== "") return void 0;
	const config = readTexpageDomainConfig(html);
	if (config === void 0 || !Object.prototype.hasOwnProperty.call(config, "socket")) return void 0;
	const expectedHost = `socket.${page.hostname.replace(/^www\./, "")}`;
	const defaultPort = page.protocol === "https:" ? "443" : "80";
	if (config.socket !== expectedHost && config.socket !== `${expectedHost}:${defaultPort}`) return void 0;
	try {
		return new URL(`${page.protocol}//${expectedHost}`);
	} catch {
		return;
	}
}
/**
* Resolve an already prefix-stripped marker path against a validated origin.
* Only these three literal paths are supported. Queries are copied byte-for-
* byte; no decoding, path normalization, redirects or caller-chosen authority.
*/
function resolveTexpageSocketTarget(subPath, socketOrigin) {
	if (socketOrigin === void 0 || subPath.length > MAX_CONFIG_CHARS || /[\u0000-\u0020\u007f#\\]/.test(subPath)) return void 0;
	let origin;
	try {
		origin = new URL(String(socketOrigin));
	} catch {
		return;
	}
	if (!["http:", "https:"].includes(origin.protocol) || origin.username !== "" || origin.password !== "" || origin.port !== "" || origin.pathname !== "/" || origin.search !== "" || origin.hash !== "" || !origin.hostname.startsWith("socket.")) return void 0;
	const queryAt = subPath.indexOf("?");
	const path = queryAt < 0 ? subPath : subPath.slice(0, queryAt);
	if (path !== `/__dsh_socket__/socket.io` && path !== `/__dsh_socket__/socket.io/` && path !== `/__dsh_socket__/heartbeat`) return void 0;
	const target = new URL(origin.origin);
	target.pathname = path.slice(15);
	target.search = queryAt < 0 ? "" : subPath.slice(queryAt);
	return target;
}
//#endregion
//#region lib/types/texpage-output.js
/** Credential-free, fixed-origin transport for TeXPage's signed PDF/log artifacts. */
const OUTPUT_PROXY_PATH = "/__dsh_texpage_output__";
const OUTPUT_HOST = "latex-file.texpageusercontent.com";
const OUTPUT_ORIGIN = `https://${OUTPUT_HOST}`;
const MAX_URL_CHARS = 65536;
const OUTPUT_PATH = /^\/CompileResult\/(?:[A-Za-z0-9][A-Za-z0-9_-]{0,127}\/){3}output\.(?:pdf|log|blg)$/;
const IDLE_TIMEOUT_MS = 3e4;
const TOTAL_TIMEOUT_MS = 6e4;
/** The fixed latexFile host is trusted only alongside validated same-site socket metadata. */
function extractTexpageOutputOrigin(html, pageOrigin) {
	if (extractTexpageSocketOrigin(html, pageOrigin) === void 0) return void 0;
	const config = readTexpageDomainConfig(html);
	if (config === void 0 || !Object.prototype.hasOwnProperty.call(config, "latexFile") || config.latexFile !== OUTPUT_HOST) return void 0;
	return new URL(OUTPUT_ORIGIN);
}
/** Resolve ONLY the marker + literal PDF/log path; never decode/rebuild a signed query. */
function resolveTexpageOutputTarget(subPath, outputOrigin) {
	if (outputOrigin === void 0 || subPath.length > MAX_URL_CHARS || /[^\x21-\x7e]|[#\\]/.test(subPath) || /%(?![0-9a-f]{2})/i.test(subPath)) return void 0;
	let origin;
	try {
		origin = new URL(String(outputOrigin));
	} catch {
		return;
	}
	if (origin.href !== `${OUTPUT_ORIGIN}/` || !subPath.startsWith(`/__dsh_texpage_output__/`)) return void 0;
	const suffix = subPath.slice(23);
	const queryAt = suffix.indexOf("?");
	if (!OUTPUT_PATH.test(queryAt < 0 ? suffix : suffix.slice(0, queryAt))) return void 0;
	const expected = OUTPUT_ORIGIN + suffix;
	let target;
	try {
		target = new URL(expected);
	} catch {
		return;
	}
	return target.href === expected ? target : void 0;
}
function validTarget(target) {
	if (target.origin !== OUTPUT_ORIGIN || target.username !== "" || target.password !== "" || target.hash !== "") return false;
	const resolved = resolveTexpageOutputTarget(OUTPUT_PROXY_PATH + target.href.slice(OUTPUT_ORIGIN.length), new URL(OUTPUT_ORIGIN));
	return resolved !== void 0 && resolved.href === target.href;
}
/** Only a single byte range and a strong ETag / HTTP-date validator are accepted. */
function outputRequestHeaders(req) {
	const headers = {};
	const range = req.headers.range;
	if (range !== void 0) {
		if (typeof range !== "string" || !/^bytes=(?:\d{1,16}-\d{0,16}|-\d{1,16})$/.test(range)) return void 0;
		const [first, last] = range.slice(6).split("-");
		if (first && last && BigInt(first) > BigInt(last)) return void 0;
		headers.range = range;
	}
	const validator = req.headers["if-range"];
	if (validator !== void 0) {
		if (typeof validator !== "string" || validator.length > 256 || !/^"[\x21\x23-\x7e]*"$/.test(validator) && !/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(validator)) return void 0;
		headers["if-range"] = validator;
	}
	return headers;
}
function outputResponseHeaders(upstream, isLog) {
	const headers = {
		"cache-control": "no-store",
		"x-content-type-options": "nosniff"
	};
	const connectionFields = new Set(String(upstream.headers.connection ?? "").toLowerCase().split(",").map((x) => x.trim()));
	for (const name of [
		"content-type",
		"content-length",
		"content-range",
		"accept-ranges",
		"content-encoding",
		"etag",
		"last-modified",
		"content-disposition"
	]) {
		const value = upstream.headers[name];
		if (typeof value === "string" && !connectionFields.has(name)) headers[name] = value;
	}
	if (upstream.statusCode === 416 || isLog && (upstream.statusCode === 200 || upstream.statusCode === 206)) headers["content-type"] = "text/plain; charset=utf-8";
	return headers;
}
/** A single-part 206 must describe exactly the representation bytes it sends. */
function partialBodyLength(headers) {
	const range = headers["content-range"];
	if (typeof range !== "string") return void 0;
	const match = /^bytes (\d{1,20})-(\d{1,20})\/(\d{1,20}|\*)$/i.exec(range);
	if (match === null) return void 0;
	const first = BigInt(match[1]);
	const last = BigInt(match[2]);
	if (last < first || match[3] !== "*" && last >= BigInt(match[3])) return void 0;
	const length = last - first + 1n;
	const declared = headers["content-length"];
	if (declared !== void 0 && (typeof declared !== "string" || !/^\d{1,20}$/.test(declared) || BigInt(declared) !== length)) return void 0;
	return length;
}
/**
* Stream without fetch's decompression or the generic authenticated proxy helpers.
* No input body, cookies, auth, Origin or Referer cross this boundary. Redirects
* are rejected, never followed or returned. Errors never include the signed URL.
*/
async function serveTexpageOutput(req, res, target) {
	const reply = (status, message) => {
		if (res.destroyed || res.writableEnded) return;
		if (res.headersSent) {
			res.destroy();
			return;
		}
		res.writeHead(status, {
			"content-type": "text/plain; charset=utf-8",
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
			...status === 405 ? { allow: "GET, HEAD" } : {}
		});
		res.end(req.method === "HEAD" ? void 0 : message);
	};
	if (req.method !== "GET" && req.method !== "HEAD") {
		reply(405, "Method not allowed");
		return;
	}
	if (!validTarget(target)) {
		reply(400, "Invalid output target");
		return;
	}
	const isLog = /\/output\.(?:log|blg)$/.test(target.pathname);
	const headers = outputRequestHeaders(req);
	if (headers === void 0) {
		reply(400, "Invalid output range headers");
		return;
	}
	if (req.aborted || res.destroyed || res.writableEnded) return;
	await new Promise((resolve) => {
		let settled = false;
		let outbound;
		let upstream;
		let upstreamEnded = false;
		const totalTimer = setTimeout(() => fail(504), TOTAL_TIMEOUT_MS);
		totalTimer.unref();
		const finish = () => {
			if (settled) return;
			settled = true;
			clearTimeout(totalTimer);
			req.off("aborted", cancel);
			res.off("close", cancel);
			res.off("error", cancel);
			res.off("finish", finish);
			outbound?.off("timeout", timeout);
			upstream?.unpipe(res);
			upstream?.destroy();
			outbound?.destroy();
			resolve();
		};
		const cancel = () => {
			res.destroy();
			finish();
		};
		const fail = (status = 502) => {
			if (settled) return;
			reply(status, status === 504 ? "Output upstream timeout" : "Output upstream unavailable");
			finish();
		};
		const timeout = () => {
			fail(504);
		};
		req.once("aborted", cancel);
		res.once("close", cancel);
		res.once("error", cancel);
		res.once("finish", finish);
		try {
			outbound = https.request(target, {
				method: req.method,
				headers,
				timeout: IDLE_TIMEOUT_MS,
				path: target.href.slice(OUTPUT_ORIGIN.length)
			}, (response) => {
				if (settled) {
					response.destroy();
					return;
				}
				upstream = response;
				let receivedBytes = 0n;
				const responseHeaders = outputResponseHeaders(response, isLog);
				const expectedBytes = response.statusCode === 206 ? partialBodyLength(responseHeaders) : void 0;
				response.once("error", () => fail());
				response.once("aborted", () => fail());
				response.once("end", () => {
					upstreamEnded = true;
					if (response.complete === false || expectedBytes !== void 0 && receivedBytes !== expectedBytes) fail();
				});
				response.once("close", () => {
					if (!upstreamEnded && !settled) fail();
				});
				const status = response.statusCode ?? 502;
				if (status >= 300 && status < 400 && status !== 304) {
					fail();
					return;
				}
				if (status === 206 && expectedBytes === void 0) {
					fail();
					return;
				}
				if (![
					200,
					206,
					304,
					416
				].includes(status)) {
					fail(status >= 400 && status <= 599 ? status : 502);
					return;
				}
				const type = String(response.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
				if ((req.method !== "HEAD" || isLog) && (status === 200 || status === 206) && type !== (isLog ? "text/plain" : "application/pdf") && type !== "application/octet-stream") {
					fail();
					return;
				}
				try {
					res.writeHead(status, responseHeaders);
					if (req.method === "HEAD" || status === 304) {
						res.end();
						finish();
					} else {
						if (expectedBytes !== void 0) response.on("data", (chunk) => {
							receivedBytes += BigInt(chunk.byteLength);
							if (receivedBytes > expectedBytes) fail();
						});
						response.pipe(res);
					}
				} catch {
					fail();
				}
			});
			outbound.once("timeout", timeout);
			outbound.once("error", () => fail());
			if (settled) {
				outbound.off("timeout", timeout);
				outbound.destroy();
				return;
			}
			outbound.end();
		} catch {
			fail();
		}
	});
}
const FILE_ORIGIN$1 = "https://latex-file.texpageusercontent.com";
const MAX_BYTES$1 = 2097152;
/** No arbitrary URL, path or header supplied by the client crosses origins. */
function resolveTexpageBibTarget(subPath, site, fileOrigin) {
	if (fileOrigin?.href !== FILE_ORIGIN$1 + "/" || subPath.length > 1024 || !/^https?:$/.test(site.protocol)) return void 0;
	let url;
	try {
		url = new URL(subPath, site);
	} catch {
		return;
	}
	if (url.origin !== site.origin || url.pathname !== "/__dsh_texpage_bib__" || url.hash !== "") return void 0;
	const keys = [
		"ownerKey",
		"projectKey",
		"versionNo",
		"fileKey"
	];
	if (Array.from(url.searchParams.keys()).length !== keys.length) return void 0;
	for (const key of keys) if (url.searchParams.getAll(key).length !== 1 || !/^[A-Za-z0-9-]{1,128}$/.test(url.searchParams.get(key) ?? "")) return void 0;
	const download = new URL("/api/project/file", site);
	for (const key of [
		"projectKey",
		"versionNo",
		"fileKey"
	]) download.searchParams.set(key, url.searchParams.get(key));
	return {
		download,
		objectPath: "/" + url.searchParams.get("ownerKey") + "/" + url.searchParams.get("fileKey") + "_" + url.searchParams.get("versionNo")
	};
}
function resolveTexpageBibRedirect(raw, target) {
	if (raw.length > 65536 || /[^\x21-\x7e]|[#\\]/.test(raw) || /%(?![0-9a-f]{2})/i.test(raw)) return void 0;
	let url;
	try {
		url = new URL(raw);
	} catch {
		return;
	}
	return url.origin === FILE_ORIGIN$1 && url.username === "" && url.password === "" && url.pathname === target.objectPath && url.href === raw ? url : void 0;
}
/** One authenticated request to the configured site, at most one credential-free
* signed-object read. No redirects, cookies or signed URLs are returned/logged. */
async function serveTexpageBib(req, res, target, siteHeaders, request = fetch) {
	let stage = "site";
	let failure = "site-network";
	const reply = (status, text) => {
		if (res.destroyed || res.writableEnded) return;
		res.writeHead(status, {
			"content-type": "text/plain; charset=utf-8",
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
			...status === 405 ? { allow: "GET" } : {},
			...status === 502 || status === 504 ? { "x-dsh-bib-error": failure } : {}
		});
		res.end(text);
	};
	if (req.method !== "GET") {
		reply(405, "Method not allowed");
		return;
	}
	if (req.aborted || res.destroyed) return;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 18e3);
	timer.unref();
	const cancel = () => controller.abort();
	req.once("aborted", cancel);
	res.once("close", cancel);
	let response;
	try {
		const headers = {
			accept: "text/plain, application/octet-stream",
			"cache-control": "no-cache"
		};
		for (const key of [
			"cookie",
			"authorization",
			"user-agent"
		]) if (typeof siteHeaders[key] === "string") headers[key] = siteHeaders[key];
		response = await request(target.download, {
			headers,
			redirect: "manual",
			signal: controller.signal
		});
		if (response.status === 302 || response.status === 303 || response.status === 307) {
			stage = "redirect";
			failure = "redirect-target";
			const signed = resolveTexpageBibRedirect(response.headers.get("location") ?? "", target);
			await response.body?.cancel();
			response = void 0;
			if (!signed) throw new Error("invalid-target");
			stage = "object";
			failure = "object-network";
			response = await request(signed, {
				redirect: "manual",
				credentials: "omit",
				headers: {
					accept: "text/plain, application/octet-stream",
					"cache-control": "no-cache"
				},
				signal: controller.signal
			});
		}
		failure = stage + "-http-" + response.status;
		if (response.status !== 200) throw new Error("read-failed");
		failure = stage + "-mime";
		const type = (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
		if (![
			"text/plain",
			"application/octet-stream",
			"application/x-bibtex",
			"text/x-bibtex"
		].includes(type ?? "")) throw new Error("invalid-type");
		stage = "body";
		failure = "body-size";
		if (Number(response.headers.get("content-length")) > MAX_BYTES$1) throw new Error("too-large");
		failure = "body-stream";
		const reader = response.body?.getReader();
		if (!reader) throw new Error("empty-body");
		const chunks = [];
		let length = 0;
		try {
			while (true) {
				const part = await reader.read();
				if (part.done) break;
				length += part.value.byteLength;
				if (length > MAX_BYTES$1) {
					failure = "body-size";
					throw new Error("too-large");
				}
				chunks.push(part.value);
			}
		} finally {
			reader.releaseLock();
		}
		const bytes = Buffer.concat(chunks);
		failure = "body-utf8";
		const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		failure = "body-mime";
		if (/^\s*(?:<!doctype\s+html|<html\b)/i.test(text)) throw new Error("invalid-type");
		reply(200, text);
	} catch {
		if (controller.signal.aborted) failure = stage + "-timeout";
		reply(controller.signal.aborted ? 504 : 502, "Bibliography readback unavailable");
	} finally {
		await response?.body?.cancel().catch(() => {});
		clearTimeout(timer);
		req.off("aborted", cancel);
		res.off("close", cancel);
	}
}
const FILE_ORIGIN = "https://latex-file.texpageusercontent.com";
const MAX_BYTES = 4194304;
/** No arbitrary URL, path or header supplied by the client crosses origins. */
function resolveTexpageTexTarget(subPath, site, fileOrigin) {
	if (fileOrigin?.href !== FILE_ORIGIN + "/" || subPath.length > 1024 || !/^https?:$/.test(site.protocol)) return void 0;
	let url;
	try {
		url = new URL(subPath, site);
	} catch {
		return;
	}
	if (url.origin !== site.origin || url.pathname !== "/__dsh_texpage_tex__" || url.hash !== "") return void 0;
	const keys = [
		"ownerKey",
		"projectKey",
		"versionNo",
		"fileKey"
	];
	if (Array.from(url.searchParams.keys()).length !== keys.length) return void 0;
	for (const key of keys) if (url.searchParams.getAll(key).length !== 1 || !/^[A-Za-z0-9_-]{1,128}$/.test(url.searchParams.get(key) ?? "")) return void 0;
	const download = new URL("/api/project/file", site);
	for (const key of [
		"projectKey",
		"versionNo",
		"fileKey"
	]) download.searchParams.set(key, url.searchParams.get(key));
	return {
		download,
		objectPath: "/" + url.searchParams.get("ownerKey") + "/" + url.searchParams.get("fileKey") + "_" + url.searchParams.get("versionNo")
	};
}
function resolveTexpageTexRedirect(raw, target) {
	if (raw.length > 65536 || /[^\x21-\x7e]|[#\\]/.test(raw) || /%(?![0-9a-f]{2})/i.test(raw)) return void 0;
	let url;
	try {
		url = new URL(raw);
	} catch {
		return;
	}
	return url.origin === FILE_ORIGIN && url.username === "" && url.password === "" && url.pathname === target.objectPath && url.href === raw ? url : void 0;
}
/** One authenticated request to the configured site, then at most one
* credential-free signed-object read. Redirects and signed URLs never escape. */
async function serveTexpageTex(req, res, target, siteHeaders, request = fetch) {
	let stage = "site";
	let failure = "site-network";
	const reply = (status, text) => {
		if (res.destroyed || res.writableEnded) return;
		res.writeHead(status, {
			"content-type": "text/plain; charset=utf-8",
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
			...status === 405 ? { allow: "GET" } : {},
			...status === 502 || status === 504 ? { "x-dsh-tex-error": failure } : {}
		});
		res.end(text);
	};
	if (req.method !== "GET") {
		reply(405, "Method not allowed");
		return;
	}
	if (req.aborted || res.destroyed) return;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 18e3);
	timer.unref();
	const cancel = () => controller.abort();
	req.once("aborted", cancel);
	res.once("close", cancel);
	let response;
	try {
		const headers = {
			accept: "text/plain, application/octet-stream",
			"cache-control": "no-cache"
		};
		for (const key of [
			"cookie",
			"authorization",
			"user-agent"
		]) if (typeof siteHeaders[key] === "string") headers[key] = siteHeaders[key];
		response = await request(target.download, {
			headers,
			redirect: "manual",
			signal: controller.signal
		});
		if (response.status === 302 || response.status === 303 || response.status === 307) {
			stage = "redirect";
			failure = "redirect-target";
			const signed = resolveTexpageTexRedirect(response.headers.get("location") ?? "", target);
			await response.body?.cancel();
			response = void 0;
			if (!signed) throw new Error("invalid-target");
			stage = "object";
			failure = "object-network";
			response = await request(signed, {
				redirect: "manual",
				credentials: "omit",
				headers: {
					accept: "text/plain, application/octet-stream",
					"cache-control": "no-cache"
				},
				signal: controller.signal
			});
		}
		failure = stage + "-http-" + response.status;
		if (response.status !== 200) throw new Error("read-failed");
		failure = stage + "-mime";
		const type = (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
		if (![
			"text/plain",
			"application/octet-stream",
			"application/x-tex",
			"text/x-tex"
		].includes(type ?? "")) throw new Error("invalid-type");
		stage = "body";
		failure = "body-size";
		if (Number(response.headers.get("content-length")) > MAX_BYTES) throw new Error("too-large");
		failure = "body-stream";
		const reader = response.body?.getReader();
		if (!reader) throw new Error("empty-body");
		const chunks = [];
		let length = 0;
		try {
			while (true) {
				const part = await reader.read();
				if (part.done) break;
				length += part.value.byteLength;
				if (length > MAX_BYTES) {
					failure = "body-size";
					throw new Error("too-large");
				}
				chunks.push(part.value);
			}
		} finally {
			reader.releaseLock();
		}
		const bytes = Buffer.concat(chunks);
		failure = "body-utf8";
		const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		failure = "body-mime";
		if (/^\s*(?:<!doctype\s+html|<html\b)/i.test(text)) throw new Error("invalid-type");
		reply(200, text);
	} catch {
		if (controller.signal.aborted) failure = stage + "-timeout";
		reply(controller.signal.aborted ? 504 : 502, "TeX readback unavailable");
	} finally {
		await response?.body?.cancel().catch(() => {});
		clearTimeout(timer);
		req.off("aborted", cancel);
		res.off("close", cancel);
	}
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
		const socketOrigin = targetOrigin !== void 0 ? extractTexpageSocketOrigin(html, targetOrigin) : void 0;
		const outputOrigin = targetOrigin !== void 0 ? extractTexpageOutputOrigin(html, targetOrigin) : void 0;
		const bootstrapValues = [
			...wsPort > 0 ? [`window.__DSH_OVERLEAF_WS_PORT__=${wsPort};`] : [],
			...targetOrigin !== void 0 ? [`window.__DSH_OVERLEAF_UPSTREAM_ORIGIN__=${JSON.stringify(targetOrigin)};`] : [],
			...socketOrigin !== void 0 ? [`window.__DSH_OVERLEAF_SOCKET_ORIGIN__=${JSON.stringify(socketOrigin.origin)};`] : [],
			...outputOrigin !== void 0 ? [`window.__DSH_OVERLEAF_TEXPAGE_OUTPUT_ORIGIN__=${JSON.stringify(outputOrigin.origin)};`] : []
		].join("");
		const tag = `${bootstrapValues !== "" ? `<script${nonceAttr}>${bootstrapValues}<\/script>\n` : ""}<script src="${injectScriptSrc}"${nonceAttr} data-dsh-overleaf-bridge><\/script>`;
		if (/<head[^>]*>/i.test(out)) out = out.replace(/<head[^>]*>/i, (match) => `${match}\n${tag}\n`);
		else if (/<html[^>]*>/i.test(out)) out = out.replace(/<html[^>]*>/i, (match) => `${match}\n${tag}\n`);
		else out = `${tag}\n${out}`;
	}
	return rewriteTexpageScriptTags(out, prefix);
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
	/** Only a validated same-site socket host announced by upstream HTML. */
	socketOrigin = void 0;
	/** Fixed, credential-free PDF host announced by a validated TeXPage shell. */
	texpageOutputOrigin = void 0;
	learnTexpageOutput(html) {
		const origin = extractTexpageOutputOrigin(html, this.target.origin);
		if (origin !== void 0) this.texpageOutputOrigin = origin;
	}
	learnTexpageSocket(html) {
		const origin = extractTexpageSocketOrigin(html, this.target.origin);
		if (origin !== void 0) this.socketOrigin = origin;
	}
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
	targetFor(subPath, allowContent = true) {
		if (subPath.startsWith("/__dsh_texpage_output__") || subPath.startsWith("/__dsh_texpage_bib__") || subPath.startsWith("/__dsh_texpage_tex__")) throw new Error("dsh-overleaf: content target requires isolated handler");
		if (subPath.startsWith("/__dsh_socket__")) {
			const socketTarget = resolveTexpageSocketTarget(subPath, this.socketOrigin);
			if (socketTarget === void 0) throw new Error("dsh-overleaf: unregistered or invalid socket target");
			return socketTarget;
		}
		const rule = this.contentRule;
		if (allowContent && rule !== void 0 && contentPathMatches(subPath, rule)) return new URL(subPath, rule.origin);
		const target = new URL(subPath, this.target);
		if (target.origin !== this.target.origin) throw new Error("dsh-overleaf: external proxy path refused");
		return target;
	}
	/** Whether the given raw request URL belongs to this proxy. */
	matches(rawUrl) {
		if (rawUrl === void 0) return false;
		return rawUrl === "/overleaf-proxy" || rawUrl.startsWith(`/overleaf-proxy/`);
	}
	/** Handle one matched proxied HTTP request end-to-end. */
	async handle(req, res) {
		const subPath = subPathOf(req.url, PROXY_PREFIX);
		if (subPath.startsWith("/__dsh_texpage_tex__")) {
			const texTarget = resolveTexpageTexTarget(subPath, this.target, this.texpageOutputOrigin);
			if (texTarget === void 0) {
				res.writeHead(400, {
					"content-type": "text/plain",
					"cache-control": "no-store"
				});
				res.end("dsh-overleaf: unregistered or invalid TeX target");
				return;
			}
			await serveTexpageTex(req, res, texTarget, buildUpstreamHeaders(req, texTarget.download, this.extraCookie));
			return;
		}
		if (subPath.startsWith("/__dsh_texpage_bib__")) {
			const bibTarget = resolveTexpageBibTarget(subPath, this.target, this.texpageOutputOrigin);
			if (bibTarget === void 0) {
				res.writeHead(400, {
					"content-type": "text/plain",
					"cache-control": "no-store"
				});
				res.end("dsh-overleaf: unregistered or invalid bibliography target");
				return;
			}
			await serveTexpageBib(req, res, bibTarget, buildUpstreamHeaders(req, bibTarget.download, this.extraCookie));
			return;
		}
		if (subPath.startsWith("/__dsh_texpage_output__")) {
			const outputTarget = resolveTexpageOutputTarget(subPath, this.texpageOutputOrigin);
			if (outputTarget === void 0) {
				res.writeHead(400, {
					"content-type": "text/plain",
					"cache-control": "no-store"
				});
				res.end("dsh-overleaf: unregistered or invalid PDF target");
				return;
			}
			await serveTexpageOutput(req, res, outputTarget);
			return;
		}
		const publicAsset = texpageAssetUrl(subPath);
		if (publicAsset !== void 0) {
			await serveTexpageConsoleAsset(req, res, publicAsset, PROXY_PREFIX);
			return;
		}
		let target;
		try {
			target = this.targetFor(subPath);
		} catch {
			res.writeHead(400, { "content-type": "text/plain" });
			res.end("dsh-overleaf: invalid proxy target");
			return;
		}
		const upstreamHeaders = buildUpstreamHeaders(req, target, this.extraCookie);
		if (subPath.startsWith("/__dsh_socket__")) upstreamHeaders["origin"] = this.target.origin;
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
					}, (html) => {
						if (target.origin === this.target.origin) {
							this.learnTexpageSocket(html);
							this.learnTexpageOutput(html);
						}
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
		let target;
		try {
			target = this.targetFor(subPath, false);
		} catch {
			socket.destroy();
			return;
		}
		if (subPath.startsWith("/__dsh_socket__") && !/^\/socket\.io\/?$/.test(target.pathname)) {
			socket.destroy();
			return;
		}
		const isTls = target.protocol === "https:";
		const port = Number(target.port) || (isTls ? 443 : 80);
		let upstreamSocket;
		const destroyBoth = () => {
			socket.destroy();
			upstreamSocket?.destroy();
		};
		const connectCallback = () => {
			try {
				upstreamSocket.setTimeout(0);
				writeUpgradeRequest(req, target.pathname + target.search, target, this.extraCookie, upstreamSocket, head, this.target.origin);
				spliceSockets(socket, upstreamSocket, destroyBoth);
			} catch {
				destroyBoth();
			}
		};
		upstreamSocket = isTls ? connect({
			host: target.hostname,
			port,
			servername: target.hostname
		}, connectCallback) : net.connect({
			host: target.hostname,
			port
		}, connectCallback);
		upstreamSocket.setTimeout(UPGRADE_CONNECT_TIMEOUT_MS);
		upstreamSocket.once("timeout", () => destroyBoth());
		upstreamSocket.once("error", destroyBoth);
		socket.once("error", destroyBoth);
	}
};
/** Stream one upstream HTTP response to the client, rewriting small HTML bodies. */
async function deliverResponse(res, upstreamRes, target, injectScriptSrc, wsAllowOrigin, wsPort, learnContent, learnSocket, settle) {
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
			learnSocket(htmlString);
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
function writeUpgradeRequest(req, subPath, target, extraCookie, upstreamSocket, head, pageOrigin) {
	const lines = [`GET ${subPath} HTTP/1.1`, `Host: ${target.host}`];
	for (const [name, value] of Object.entries(req.headers)) {
		const lower = name.toLowerCase();
		if (lower === "host" || lower === "cookie" || lower === "origin" || lower === "referer") continue;
		if (lower === "te" || lower === "trailer" || lower === "proxy-authenticate" || lower === "proxy-authorization") continue;
		for (const item of Array.isArray(value) ? value : [value]) if (item !== void 0 && item !== "") lines.push(`${name}: ${item}`);
	}
	if (typeof req.headers.origin === "string") lines.push(`Origin: ${pageOrigin}`);
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
//#region lib/types/texpage-bib.js
/** Self-contained: serialized into the bridge after TypeScript compilation. */
function createTexpageBibAdapter(env) {
	const pageWindow = window;
	const prefix = "/overleaf-proxy";
	const maxBytes = 2097152;
	const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
	let context;
	let busy = false;
	let readDiagnostic;
	const normalize = (text) => text.replace(/\r\n?/g, "\n");
	const sleep = () => new Promise((resolve) => setTimeout(resolve, 150));
	function fail(code) {
		throw new Error(code);
	}
	const result = (message) => env.report({
		type: "bib-sync-done",
		...message
	});
	function enabled() {
		try {
			const upstream = new URL(pageWindow.__DSH_OVERLEAF_UPSTREAM_ORIGIN__ ?? "");
			const socket = new URL(pageWindow.__DSH_OVERLEAF_SOCKET_ORIGIN__ ?? "");
			return /^https?:$/.test(upstream.protocol) && socket.protocol === upstream.protocol && socket.host === "socket." + upstream.hostname.replace(/^www\./, "") && upstream.port === "" && socket.port === "" && /\/project\/user\/[^/]+\/[^/]+/.test(location.pathname);
		} catch {
			return false;
		}
	}
	function pageMatches(candidate) {
		const match = /\/project\/user\/([^/]+)\/([^/?#]+)/.exec(location.pathname);
		return !!match && candidate.projectKey === match[1] && candidate.versionNo === match[2] && Object.values(candidate).every((value) => idPattern.test(value));
	}
	/** Observe only the same-origin, successful file-tree read, never arbitrary JSON. */
	function observe(rawUrl, json) {
		if (!enabled()) return;
		try {
			const url = new URL(rawUrl, location.origin);
			if (url.origin !== location.origin || ![prefix + "/api/project/fileTree", "/api/project/fileTree"].includes(url.pathname)) return;
			const payload = json;
			if (payload?.status?.code !== 1 || !Array.isArray(payload.result?.treeData)) return;
			const candidate = {
				ownerKey: url.searchParams.get("ownerKey") ?? "",
				projectKey: url.searchParams.get("projectKey") ?? "",
				versionNo: url.searchParams.get("versionNo") ?? ""
			};
			if (pageMatches(candidate)) context = candidate;
		} catch {}
	}
	function apiUrl(path, ctx, fileKey) {
		const query = new URLSearchParams(ctx);
		if (fileKey !== void 0) query.set("fileKey", fileKey);
		return prefix + path + "?" + query.toString();
	}
	/** Bounded, uncached same-origin GETs; reject redirects/login pages. */
	async function read(url, json = false, phase = json ? "tree" : "baseline") {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), json ? 8e3 : 2e4);
		try {
			for (let attempt = 1; attempt <= 2; attempt++) {
				let response;
				let retryable = true;
				readDiagnostic = {
					phase,
					code: "network",
					attempts: attempt
				};
				try {
					response = await env.fetch(url, {
						method: "GET",
						credentials: "same-origin",
						cache: "no-store",
						redirect: "error",
						signal: controller.signal
					});
					retryable = false;
					if (!response.ok) {
						const hint = response.headers.get("x-dsh-bib-error") ?? "";
						const safeHint = /^(site|redirect|object|body)-(network|target|mime|size|utf8|stream|timeout|http-[1-5][0-9]{2})$/.test(hint) ? hint : void 0;
						readDiagnostic = {
							phase,
							status: response.status,
							code: safeHint ?? "http",
							attempts: attempt
						};
						retryable = safeHint !== void 0 ? /-(network|stream|timeout|http-(408|429|500|502|503|504))$/.test(safeHint) : [
							408,
							429,
							500,
							502,
							503,
							504
						].includes(response.status);
						fail("bib-remote-read-failed");
					}
					const type = (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
					if (json ? type !== "application/json" : ![
						"text/plain",
						"application/octet-stream",
						"application/x-bibtex",
						"text/x-bibtex"
					].includes(type ?? "")) {
						readDiagnostic = {
							phase,
							status: response.status,
							code: "mime",
							attempts: attempt
						};
						fail("bib-remote-read-failed");
					}
					const limit = json ? 4 * maxBytes : maxBytes;
					const length = Number(response.headers.get("content-length"));
					readDiagnostic = {
						phase,
						code: "size",
						attempts: attempt
					};
					if (length > limit) fail("bib-file-too-large");
					readDiagnostic = {
						phase,
						code: "stream",
						attempts: attempt
					};
					const reader = response.body?.getReader();
					if (!reader) fail("bib-remote-read-failed");
					const chunks = [];
					let size = 0;
					try {
						while (true) {
							retryable = true;
							const part = await reader.read();
							retryable = false;
							if (part.done) break;
							size += part.value.byteLength;
							if (size > limit) {
								readDiagnostic = {
									phase,
									code: "size",
									attempts: attempt
								};
								fail("bib-file-too-large");
							}
							chunks.push(part.value);
						}
					} finally {
						reader.releaseLock();
					}
					const bytes = new Uint8Array(size);
					let offset = 0;
					for (const chunk of chunks) {
						bytes.set(chunk, offset);
						offset += chunk.byteLength;
					}
					readDiagnostic = {
						phase,
						code: "utf8",
						attempts: attempt
					};
					const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
					readDiagnostic = void 0;
					return decoded;
				} catch (error) {
					if (attempt < 2 && retryable && !controller.signal.aborted) {
						await response?.body?.cancel().catch(() => {});
						await sleep();
						if (!controller.signal.aborted) continue;
					}
					if (controller.signal.aborted) readDiagnostic = {
						phase,
						code: "timeout",
						attempts: attempt
					};
					if (error instanceof Error && error.message.startsWith("bib-")) throw error;
					fail("bib-remote-read-failed");
				} finally {
					await response?.body?.cancel().catch(() => {});
				}
			}
			return fail("bib-remote-read-failed");
		} catch (error) {
			if (error instanceof Error && error.message.startsWith("bib-")) throw error;
			return fail("bib-remote-read-failed");
		} finally {
			clearTimeout(timer);
		}
	}
	async function files(ctx) {
		const payload = JSON.parse(await read(apiUrl("/api/project/fileTree", ctx), true));
		if (payload?.status?.code !== 1 || !Array.isArray(payload.result?.treeData) || payload.result.treeData.length > 1e4) fail("bib-target-missing");
		const found = [];
		const seen = /* @__PURE__ */ new Set();
		for (const item of payload.result.treeData) {
			if (!item || item.projectKey !== ctx.projectKey || item.versionNo !== ctx.versionNo || typeof item.fileKey !== "string" || !idPattern.test(item.fileKey) || typeof item.fileName !== "string" || typeof item.filePath !== "string" || item.filePath.length > 2048 || /[\x00-\x1f\\]/.test(item.filePath) || item.filePath.split("/").some((s) => !s || s === "." || s === "..") || item.fileName !== item.filePath.split("/").pop() || seen.has(item.fileKey)) fail("bib-target-ambiguous");
			seen.add(item.fileKey);
			found.push({
				fileKey: item.fileKey,
				fileName: item.fileName,
				filePath: item.filePath,
				parentKey: String(item.parentKey),
				isDir: item.isDir === true,
				fileType: String(item.fileType)
			});
		}
		return found;
	}
	function nodes(path) {
		return Array.from(document.querySelectorAll(".project-directory .tree-node")).filter((node) => node.querySelector(".file-name [title]")?.getAttribute("title") === path);
	}
	async function open(target, all) {
		const deadline = Date.now() + 12e3;
		const parents = [];
		let parent = target.parentKey;
		const seen = /* @__PURE__ */ new Set();
		while (parent !== "0" && parent !== "" && parent !== "null" && parent !== "undefined") {
			if (seen.has(parent) || parents.length >= 16) fail("bib-target-ambiguous");
			seen.add(parent);
			const folder = all.find((f) => f.fileKey === parent && f.isDir);
			if (!folder) fail("bib-target-missing");
			parents.unshift(folder);
			parent = folder.parentKey;
		}
		if (!document.querySelector(".project-directory")) Array.from(document.querySelectorAll(".explorer-tab-title")).find((el) => /^(文件目录|Files|File Tree)$/i.test((el.textContent ?? "").trim()))?.click();
		for (const folder of parents) {
			while (nodes(folder.filePath).length === 0 && Date.now() < deadline) await sleep();
			const matches = nodes(folder.filePath);
			if (matches.length !== 1) fail("bib-target-ambiguous");
			const icon = matches[0].querySelector(".expand-icon-wrapper");
			if (!icon) fail("bib-target-missing");
			if (!icon.classList.contains("open")) {
				matches[0].click();
				await sleep();
			}
		}
		while (nodes(target.filePath).length === 0 && Date.now() < deadline) await sleep();
		const matches = nodes(target.filePath);
		if (matches.length !== 1) fail(matches.length > 1 ? "bib-target-ambiguous" : "bib-target-missing");
		if (!matches[0].classList.contains("selected")) matches[0].click();
		while (!identity(target)) {
			if (Date.now() >= deadline) fail("bib-editor-timeout");
			await sleep();
		}
	}
	/** The footer is derived from currentFile, not the prematurely selected row.
	* node-loading / ant-spin-spinning persist until the CRDT editor is mounted. */
	function identity(target) {
		const matches = nodes(target.filePath);
		const footer = document.querySelector(".editor-footer-path-item");
		const spinner = document.querySelector(".editor-container")?.closest(".ant-spin-nested-loading")?.querySelector(".ant-spin-spinning");
		return matches.length === 1 && matches[0].classList.contains("selected") && !matches[0].querySelector(".node-loading") && !spinner && (footer?.textContent ?? "").trim() === target.filePath;
	}
	function editor(target) {
		if (!identity(target)) fail("bib-document-changed");
		const selected = env.editor();
		if (selected.error) fail(selected.error);
		if (selected.engine !== "cm6" || !selected.editor) fail("bib-editor-unavailable");
		return selected.editor;
	}
	async function sync(name, content) {
		if (busy) {
			result({
				ok: false,
				error: "bib-sync-busy"
			});
			return;
		}
		busy = true;
		readDiagnostic = void 0;
		let wrote = false;
		try {
			if (!enabled() || !context || !pageMatches(context)) fail("bib-texpage-context-unavailable");
			const ctx = { ...context };
			const checkContext = () => {
				if (!pageMatches(ctx) || JSON.stringify(context) !== JSON.stringify(ctx)) fail("bib-document-changed");
			};
			const requested = String(name).trim();
			if (!/\.bib$/i.test(requested) || /[\\/\x00-\x1f]/.test(requested)) fail("bib-invalid-name");
			const text = normalize(String(content));
			if (new TextEncoder().encode(text).length > maxBytes) fail("bib-file-too-large");
			const all = await files(ctx);
			checkContext();
			const bibs = all.filter((f) => !f.isDir && /^text\//.test(f.fileType) && /\.bib$/i.test(f.fileName));
			const exact = bibs.filter((f) => f.fileName === requested);
			const candidates = exact.length ? exact : bibs.filter((f) => f.fileName.toLowerCase() === requested.toLowerCase());
			if (candidates.length !== 1) {
				result({
					ok: false,
					error: candidates.length ? "bib-target-ambiguous" : "bib-target-missing",
					available: bibs.map((f) => f.fileName).join(", ")
				});
				return;
			}
			const target = candidates[0];
			await open(target, all);
			checkContext();
			const view = editor(target);
			const before = view.state.doc.toString();
			const remote = normalize(await read(apiUrl("/__dsh_texpage_bib__", ctx, target.fileKey)));
			checkContext();
			if (editor(target) !== view || view.state.doc.toString() !== before) fail("bib-document-changed");
			if (normalize(before) !== remote) fail("bib-remote-changed");
			if (remote === text) {
				result({
					ok: true,
					target: target.fileName,
					chars: text.length,
					unchanged: true
				});
				return;
			}
			try {
				const key = "dsh-overleaf:bib-snapshot:" + pageWindow.__DSH_OVERLEAF_UPSTREAM_ORIGIN__ + ":" + ctx.ownerKey + ":" + ctx.projectKey + ":" + ctx.versionNo + ":" + target.fileKey;
				const snapshot = JSON.stringify({
					time: Date.now(),
					...ctx,
					docId: target.fileKey,
					path: target.filePath,
					engine: "cm6",
					doc: before
				});
				window.localStorage.setItem(key, snapshot);
				if (window.localStorage.getItem(key) !== snapshot) fail("bib-snapshot-failed");
				env.report({ type: "snapshot-saved" });
			} catch {
				fail("bib-snapshot-failed");
			}
			checkContext();
			if (editor(target) !== view || view.state.doc.toString() !== before) fail("bib-document-changed");
			wrote = true;
			view.dispatch({
				changes: {
					from: 0,
					to: before.length,
					insert: text
				},
				selection: { anchor: text.length }
			});
			if (view.state.doc.toString() !== text) fail("bib-write-verification-failed");
			view.focus();
			const deadline = Date.now() + 15e3;
			do {
				await sleep();
				checkContext();
				if (editor(target) !== view || view.state.doc.toString() !== text) fail("bib-document-changed");
				const saved = normalize(await read(apiUrl("/__dsh_texpage_bib__", ctx, target.fileKey), false, "save"));
				checkContext();
				if (editor(target) !== view || view.state.doc.toString() !== text) fail("bib-document-changed");
				if (saved === text) {
					result({
						ok: true,
						target: target.fileName,
						chars: text.length
					});
					return;
				}
			} while (Date.now() < deadline);
			fail("bib-save-timeout");
		} catch (error) {
			const code = error instanceof Error && error.message.startsWith("bib-") ? error.message : "bib-remote-read-failed";
			result({
				ok: false,
				error: code,
				written: wrote,
				...readDiagnostic ? { diagnostic: readDiagnostic } : {}
			});
		} finally {
			busy = false;
		}
	}
	return {
		enabled,
		observe,
		sync
	};
}
function renderTexpageBibAdapter() {
	return "(" + createTexpageBibAdapter.toString() + ")";
}
//#endregion
//#region lib/types/texpage-tex.js
/** Self-contained: serialized into the document-start bridge. */
function createTexpageTexAdapter(env) {
	const pageWindow = window;
	const prefix = "/overleaf-proxy";
	const maxBytes = 4194304;
	const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
	let context;
	let files = [];
	let busy = false;
	const normalize = (text) => text.replace(/\r\n?/g, "\n");
	const size = (text) => {
		try {
			return new TextEncoder().encode(text).length;
		} catch {
			return text.length;
		}
	};
	const revision = (text) => {
		let hash = 2166136261;
		for (let i = 0; i < text.length; i++) {
			hash ^= text.charCodeAt(i);
			hash = Math.imul(hash, 16777619);
		}
		return text.length + "-" + (hash >>> 0).toString(16);
	};
	const sleep = () => new Promise((resolve) => setTimeout(resolve, 150));
	function fail(code) {
		throw new Error(code);
	}
	function enabled() {
		try {
			const upstream = new URL(pageWindow.__DSH_OVERLEAF_UPSTREAM_ORIGIN__ ?? "");
			const socket = new URL(pageWindow.__DSH_OVERLEAF_SOCKET_ORIGIN__ ?? "");
			return /^https?:$/.test(upstream.protocol) && socket.protocol === upstream.protocol && socket.host === "socket." + upstream.hostname.replace(/^www\./, "") && upstream.port === "" && socket.port === "" && /\/project\/user\/[^/]+\/[^/]+/.test(location.pathname);
		} catch {
			return false;
		}
	}
	function pageMatches(candidate) {
		const match = /\/project\/user\/([^/]+)\/([^/?#]+)/.exec(location.pathname);
		return !!match && candidate.projectKey === match[1] && candidate.versionNo === match[2] && Object.values(candidate).every((value) => idPattern.test(value));
	}
	/** Cache only a successful, same-origin tree belonging to the visible route. */
	function observe(rawUrl, json) {
		if (!enabled()) return;
		try {
			const url = new URL(rawUrl, location.origin);
			if (url.origin !== location.origin || ![prefix + "/api/project/fileTree", "/api/project/fileTree"].includes(url.pathname)) return;
			const payload = json;
			if (payload?.status?.code !== 1 || !Array.isArray(payload.result?.treeData) || payload.result.treeData.length > 1e4) return;
			const candidate = {
				ownerKey: url.searchParams.get("ownerKey") ?? "",
				projectKey: url.searchParams.get("projectKey") ?? "",
				versionNo: url.searchParams.get("versionNo") ?? ""
			};
			if (!pageMatches(candidate)) return;
			const next = [];
			const seen = /* @__PURE__ */ new Set();
			for (const raw of payload.result.treeData) {
				const item = raw;
				if (!item || item.projectKey !== candidate.projectKey || item.versionNo !== candidate.versionNo || typeof item.fileKey !== "string" || !idPattern.test(item.fileKey) || seen.has(item.fileKey) || typeof item.fileName !== "string" || typeof item.filePath !== "string" || item.filePath.length > 2048 || /[\x00-\x1f\\]/.test(item.filePath) || item.filePath.split("/").some((part) => !part || part === "." || part === "..") || item.fileName !== item.filePath.split("/").pop()) return;
				seen.add(item.fileKey);
				next.push({
					fileKey: item.fileKey,
					fileName: item.fileName,
					filePath: item.filePath,
					isDir: item.isDir === true,
					fileType: String(item.fileType ?? "")
				});
			}
			context = candidate;
			files = next;
		} catch {}
	}
	function selectedPath() {
		const selected = Array.from(document.querySelectorAll(".project-directory .tree-node.selected"));
		if (selected.length !== 1 || selected[0].querySelector(".node-loading")) fail("tex-document-identity-unavailable");
		const titles = selected[0].querySelectorAll(".file-name [title]");
		if (titles.length !== 1) fail("tex-document-identity-unavailable");
		const path = (titles[0].getAttribute("title") ?? "").trim();
		if (path === "" || path.length > 2048 || /[\x00-\x1f\\]/.test(path)) fail("tex-document-identity-unavailable");
		const footer = document.querySelector(".editor-footer-path-item");
		if (document.querySelector(".editor-container")?.closest(".ant-spin-nested-loading")?.querySelector(".ant-spin-spinning") || (footer?.textContent ?? "").trim() !== path) fail("tex-document-identity-mismatch");
		return path;
	}
	function identity() {
		if (!enabled() || !context || !pageMatches(context) || files.length === 0) fail("tex-document-identity-unavailable");
		const path = selectedPath();
		const matches = files.filter((file) => !file.isDir && file.filePath === path);
		if (matches.length !== 1) fail("tex-document-identity-unavailable");
		const file = matches[0];
		if (!/\.tex$/i.test(file.fileName)) fail("tex-current-document-not-tex");
		if (!/^text\//.test(file.fileType)) fail("tex-document-identity-unavailable");
		const selected = env.editor();
		if (selected.error) fail(selected.error.replace(/^bib-/, "tex-"));
		if (selected.engine !== "cm6" || !selected.editor) fail("tex-editor-unavailable");
		const text = selected.editor.state.doc.toString();
		if (size(text) > maxBytes) fail("tex-document-too-large");
		return {
			ctx: { ...context },
			file,
			view: selected.editor,
			text
		};
	}
	function emit(requestId) {
		try {
			const current = identity();
			env.report({
				type: "tex-document",
				requestId,
				ok: true,
				id: current.file.fileKey,
				name: current.file.fileName,
				text: current.text,
				revision: revision(current.text)
			});
		} catch (error) {
			env.report({
				type: "tex-document",
				requestId,
				ok: false,
				error: error instanceof Error ? error.message : String(error)
			});
		}
	}
	function apiUrl(ctx, fileKey) {
		const query = new URLSearchParams({
			...ctx,
			fileKey
		});
		return prefix + "/__dsh_texpage_tex__?" + query.toString();
	}
	async function read(ctx, fileKey) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 1e4);
		let response;
		try {
			response = await env.fetch(apiUrl(ctx, fileKey), {
				method: "GET",
				credentials: "same-origin",
				cache: "no-store",
				redirect: "error",
				signal: controller.signal
			});
			if (!response.ok) fail("tex-remote-read-failed");
			const type = (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
			if (![
				"text/plain",
				"application/octet-stream",
				"application/x-tex",
				"text/x-tex"
			].includes(type ?? "")) fail("tex-remote-read-failed");
			if (Number(response.headers.get("content-length")) > maxBytes) fail("tex-document-too-large");
			const reader = response.body?.getReader();
			if (!reader) fail("tex-remote-read-failed");
			const chunks = [];
			let size = 0;
			try {
				while (true) {
					const part = await reader.read();
					if (part.done) break;
					size += part.value.byteLength;
					if (size > maxBytes) fail("tex-document-too-large");
					chunks.push(part.value);
				}
			} finally {
				reader.releaseLock();
			}
			const bytes = new Uint8Array(size);
			let offset = 0;
			for (const chunk of chunks) {
				bytes.set(chunk, offset);
				offset += chunk.byteLength;
			}
			return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		} catch (error) {
			if (error instanceof Error && error.message.startsWith("tex-")) throw error;
			return fail("tex-remote-read-failed");
		} finally {
			clearTimeout(timer);
			await response?.body?.cancel().catch(() => {});
		}
	}
	function sameIdentity(expected, expectedText) {
		const current = identity();
		if (JSON.stringify(current.ctx) !== JSON.stringify(expected.ctx) || current.file.fileKey !== expected.file.fileKey || current.view !== expected.view || current.text !== expectedText) fail("tex-remote-changed");
	}
	async function sync(content, confirmed, requestId, expectedDocId, expectedRevision) {
		if (busy) {
			env.report({
				type: "tex-overleaf-sync-done",
				requestId,
				ok: false,
				error: "tex-sync-busy"
			});
			return;
		}
		busy = true;
		let wrote = false;
		try {
			if (confirmed !== true) fail("tex-reverse-confirmation-required");
			const text = normalize(String(content));
			if (size(text) > maxBytes) fail("tex-document-too-large");
			const current = identity();
			if (expectedDocId !== current.file.fileKey || expectedRevision !== revision(current.text)) fail("tex-remote-changed");
			const baseline = await read(current.ctx, current.file.fileKey);
			sameIdentity(current, current.text);
			if (normalize(baseline) !== normalize(current.text)) fail("tex-remote-changed");
			if (current.text === text) {
				env.report({
					type: "tex-overleaf-sync-done",
					requestId,
					ok: true,
					target: current.file.fileName,
					chars: text.length,
					unchanged: true
				});
				return;
			}
			const key = "dsh-overleaf:tex-snapshot:" + (pageWindow.__DSH_OVERLEAF_UPSTREAM_ORIGIN__ ?? "") + ":" + current.ctx.ownerKey + ":" + current.ctx.projectKey + ":" + current.ctx.versionNo + ":" + current.file.fileKey;
			const snapshot = JSON.stringify({
				time: Date.now(),
				...current.ctx,
				docId: current.file.fileKey,
				path: current.file.filePath,
				engine: "cm6",
				doc: current.text
			});
			window.localStorage.setItem(key, snapshot);
			if (window.localStorage.getItem(key) !== snapshot) fail("tex-snapshot-failed");
			env.report({ type: "snapshot-saved" });
			sameIdentity(current, current.text);
			wrote = true;
			current.view.dispatch({
				changes: {
					from: 0,
					to: current.text.length,
					insert: text
				},
				selection: { anchor: text.length }
			});
			if (current.view.state.doc.toString() !== text) fail("tex-write-verification-failed");
			current.view.focus();
			const deadline = Date.now() + 15e3;
			do {
				await sleep();
				sameIdentity(current, text);
				const saved = await read(current.ctx, current.file.fileKey);
				sameIdentity(current, text);
				if (normalize(saved) === text) {
					env.report({
						type: "tex-overleaf-sync-done",
						requestId,
						ok: true,
						target: current.file.fileName,
						chars: text.length
					});
					return;
				}
			} while (Date.now() < deadline);
			fail("tex-save-timeout");
		} catch (error) {
			env.report({
				type: "tex-overleaf-sync-done",
				requestId,
				ok: false,
				error: error instanceof Error && error.message.startsWith("tex-") ? error.message : "tex-remote-read-failed",
				wrote
			});
		} finally {
			busy = false;
		}
	}
	return {
		enabled,
		observe,
		emit,
		sync
	};
}
function renderTexpageTexAdapter() {
	return "(" + createTexpageTexAdapter.toString() + ")";
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
      if (raw.charAt(0) === '/' && raw.indexOf('//') !== 0) {
        if (raw === PREFIX || raw.indexOf('/overleaf/workbench/') === 0) return raw
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
        var upstreamOrigin = typeof window.__DSH_OVERLEAF_UPSTREAM_ORIGIN__ === 'string'
          ? window.__DSH_OVERLEAF_UPSTREAM_ORIGIN__ : ''
        var upstreamProtocol = upstreamOrigin ? new URL(upstreamOrigin).protocol : location.protocol
        var protocolRelative = raw.indexOf('//') === 0
        var parsed = new URL(protocolRelative ? upstreamProtocol + raw : raw)
        // blob: URLs report their creator's origin, but are not HTTP resources.
        // PDF viewers/workers must keep those object URLs intact.
        if (!/^https?:$/.test(parsed.protocol)) return raw
        // TeXPage builds API bases with location.hostname (no loopback port).
        // Only that protocol-relative, implicit-port form aliases this proxy;
        // explicit other ports/hosts remain external.
        var implicitCurrentHost = protocolRelative && parsed.hostname === window.location.hostname && parsed.port === ''
        // TeXPage returns signed PDF URLs over Socket.IO, not Overleaf compile
        // JSON/meta tags. Send only the announced fixed host's PDF/log outputs
        // through its isolated credential-free handler; preserve signed query.
        var announcedOutput = window.__DSH_OVERLEAF_TEXPAGE_OUTPUT_ORIGIN__
        if (announcedOutput === 'https://latex-file.texpageusercontent.com'
          && parsed.origin === announcedOutput && parsed.username === '' && parsed.password === ''
          && /^\\/CompileResult\\/[a-zA-Z0-9_-]+\\/[a-zA-Z0-9_-]+\\/[a-zA-Z0-9_-]+\\/output\\.(?:pdf|log|blg)$/.test(parsed.pathname)) {
          markDiagnostic(/\\.pdf$/.test(parsed.pathname) ? 'pdf-route' : 'log-route', 'texpage-same-origin')
          return window.location.origin + PREFIX + '/__dsh_texpage_output__' + parsed.pathname + parsed.search
        }
        var announcedSocket = window.__DSH_OVERLEAF_SOCKET_ORIGIN__
        if (typeof announcedSocket === 'string' && /^https?:$/.test(parsed.protocol) && parsed.host === new URL(announcedSocket).host
          && /^\\/(?:socket\\.io\\/?|heartbeat)$/.test(parsed.pathname)) {
          return window.location.origin + PREFIX + '/__dsh_socket__' + parsed.pathname + parsed.search + parsed.hash
        }
        var isWorkbenchRoute = parsed.pathname.indexOf('/overleaf/workbench/') === 0
        var isAlreadyProxied = parsed.pathname === PREFIX || parsed.pathname.indexOf(PREFIX + '/') === 0
        if ((parsed.origin === window.location.origin || parsed.origin === upstreamOrigin || implicitCurrentHost)
          && !isWorkbenchRoute && !isAlreadyProxied) {
          return window.location.origin + PREFIX + parsed.pathname + parsed.search + parsed.hash
        }
        // Absolute URLs on the site's user-content output origin are re-rooted
        // under the proxy (keeps the path - the host proxy forwards zone paths
        // to that origin after learning it from the compile result).
        var contentDom = contentOrigin()
        if (contentDom !== '' && parsed.origin === contentDom && !isWorkbenchRoute && !isAlreadyProxied) {
          return PREFIX + parsed.pathname + parsed.search + parsed.hash
        }
        if (protocolRelative) return parsed.toString()
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
  var compileGeneration = 0
  var logFetchInFlight = Object.create(null)

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
    var pathName = pathnameOf(rawUrl)
    if (pathName.indexOf(PREFIX + '/') === 0) pathName = pathName.slice(PREFIX.length)
    return /^\\/project\\/[^/]+\\/compile\\/?$/.test(pathName)
  }

  function isCachedCompileResponse(rawUrl) {
    var pathName = pathnameOf(rawUrl)
    if (pathName.indexOf(PREFIX + '/') === 0) pathName = pathName.slice(PREFIX.length)
    return /^\\/project\\/[^/]+\\/output\\/cached\\/output\\.overleaf\\.json$/.test(pathName)
  }

  function isOutputPdf(rawUrl) {
    return /\\/output\\/output\\.pdf(?:[?#]|$)/.test(pathnameOf(rawUrl))
  }

  function isCompileLog(rawUrl) {
    return /\\/output\\/[^/]+\\.(?:log|blg)$/i.test(pathnameOf(rawUrl))
  }

  function compileLogPath(rawUrl) {
    var pathName = pathnameOf(rawUrl)
    var name = pathName.slice(pathName.lastIndexOf('/') + 1)
    return name || 'output.log'
  }

  function truncateText(text, max) {
    if (typeof text !== 'string') return ''
    return text.length > max ? text.slice(0, max) + '\\n...[truncated]' : text
  }

  function fetchWithTimeout(url) {
    try {
      var controller = typeof AbortController === 'function' ? new AbortController() : undefined
      if (controller) setTimeout(function () { try { controller.abort() } catch (err) {} }, 30000)
      var fetchImpl = originalFetch || window.fetch
      return fetchImpl.call(window, routeUrl(url), {
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

  function beginCompileGeneration(status) {
    compileGeneration += 1
    lastCompileStatus = status || 'compiling'
    lastCompileLogs = []
    publishCompileLog()
    return compileGeneration
  }

  function storeCompileLog(captured, generation) {
    if (generation !== compileGeneration) return
    var previous = lastCompileLogs || []
    var rest = previous.filter(function (item) { return item && item.path !== captured.path })
    lastCompileLogs = rest.concat([captured])
    markDiagnostic('compile-log', captured.path + (captured.error ? ':' + captured.error : ':' + captured.text.length))
    publishCompileLog()
  }

  function fetchAndPublishLog(fullUrl, pathName, generation) {
    var requestGeneration = typeof generation === 'number' ? generation : compileGeneration
    var flightKey = String(requestGeneration) + '|' + String(fullUrl)
    if (logFetchInFlight[flightKey]) return
    logFetchInFlight[flightKey] = true
    fetchWithTimeout(fullUrl)
      .then(function (response) {
        if (!response.ok) return { path: pathName, text: '', error: 'HTTP ' + response.status }
        return response.text().then(function (text) {
          return { path: pathName, text: truncateText(text, 1048576) }
        })
      })
      .then(function (captured) {
        storeCompileLog(captured, requestGeneration)
      })
      .catch(function (err) {
        storeCompileLog({
          path: pathName,
          text: '',
          error: err && err.message ? String(err.message) : String(err),
        }, requestGeneration)
        if (DEBUG) log('compile log fetch failed', err)
      })
      .finally(function () { delete logFetchInFlight[flightKey] })
  }

  /* Overleaf itself reads output.log to build its native error panel. Capture
     that successful response too: it is the most reliable source because it
     already contains the exact build URL and authorization query selected by
     the current frontend. */
  function captureObservedLogResponse(response, rawUrl, generation) {
    var pathName = compileLogPath(rawUrl)
    try {
      if (!response || !response.ok) {
        storeCompileLog({ path: pathName, text: '', error: 'HTTP ' + (response ? response.status : 0) }, generation)
        return
      }
      response.clone().text()
        .then(function (text) {
          storeCompileLog({ path: pathName, text: truncateText(text, 1048576) }, generation)
        })
        .catch(function (err) {
          storeCompileLog({ path: pathName, text: '', error: String(err) }, generation)
        })
    } catch (err) {
      storeCompileLog({ path: pathName, text: '', error: String(err) }, generation)
    }
  }

  /* Observed on a compile POST response: read outputFiles, fetch every
     .log/.blg through the proxy with the same compileGroup/clsiServerId
     query the frontend uses. */
  function captureCompileResponse(json, requestedGeneration) {
    try {
      if (!json || !json.outputFiles || !Array.isArray(json.outputFiles)) return
      var generation = typeof requestedGeneration === 'number'
        ? requestedGeneration
        : beginCompileGeneration(typeof json.status === 'string' ? json.status : 'unknown')
      if (generation !== compileGeneration) return
      if (typeof json.status === 'string') lastCompileStatus = json.status
      publishCompileLog()
      var pdfDomain = typeof json.pdfDownloadDomain === 'string' ? json.pdfDownloadDomain : ''
      var params = new URLSearchParams()
      if (json.compileGroup) params.set('compileGroup', String(json.compileGroup))
      if (json.clsiServerId) params.set('clsiserverid', String(json.clsiServerId))
      for (var p = 0; p < json.outputFiles.length; p++) {
        var pdfEntry = json.outputFiles[p]
        if (pdfEntry && pdfEntry.path === 'output.pdf' && pdfEntry.editorId) {
          params.set('editorId', String(pdfEntry.editorId))
          break
        }
      }
      params.set('enable_pdf_caching', 'true')
      var found = []
      for (var i = 0; i < json.outputFiles.length; i++) {
        var entry = json.outputFiles[i]
        var filePath = entry && typeof entry.path === 'string' ? entry.path : ''
        var relUrl = entry && typeof entry.url === 'string' ? entry.url : ''
        if (!/\\.(?:log|blg)$/i.test(filePath) || relUrl === '' || found.length >= 4) continue
        /* Match Overleaf's own URL builder: only entries explicitly marked as
           build artifacts use pdfDownloadDomain. output.log normally stays on
           window.origin and therefore must travel through /overleaf-proxy. */
        var target = entry && entry.build && pdfDomain !== '' && relUrl.charAt(0) === '/'
          ? pdfDomain + relUrl
          : relUrl
        var absoluteTarget = target.indexOf('//') === 0
          ? location.protocol + target
          : (/^[a-z][a-z0-9+.-]*:/i.test(target) ? target : location.origin + (target.charAt(0) === '/' ? target : '/' + target))
        var parsedTarget = new URL(absoluteTarget)
        params.forEach(function (value, key) {
          if (!parsedTarget.searchParams.has(key)) parsedTarget.searchParams.set(key, value)
        })
        found.push({ path: filePath, url: routeUrl(parsedTarget.toString()) })
      }
      for (var j = 0; j < found.length; j++) {
        fetchAndPublishLog(found[j].url, found[j].path, generation)
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
      /* /download/project/.../output.pdf is a download controller, not the
         output-file path. Replacing its extension produces a guaranteed 404. */
      if (/\\/download\\/project\\//.test(parsed.pathname)) return
      parsed.pathname = parsed.pathname.replace(/\\.pdf$/i, '.log')
      fetchAndPublishLog(parsed.toString(), 'output.log', compileGeneration)
    } catch (err) {
      if (DEBUG) log('pdf log fallback failed', err)
    }
  }

  function currentFileTreeDocument() {
    try {
      var root = document.querySelector('[data-testid="file-tree-list-root"]')
      if (!root) return undefined
      var selected = root.querySelectorAll('[role="treeitem"][aria-selected="true"][aria-label]')
      var found = []
      for (var i = 0; i < selected.length; i++) {
        var entity = selected[i].querySelector('.entity[data-file-id][data-file-type="doc"]')
        if (!entity) continue
        var name = String(selected[i].getAttribute('aria-label') || '').replace(/[\u200e\u200f]/g, '').trim()
        if (name === '') continue
        found.push({ item: selected[i], entity: entity, id: String(entity.getAttribute('data-file-id') || ''), name: name })
      }
      return found.length === 1 ? found[0] : undefined
    } catch (err) {
      return undefined
    }
  }

  function currentDocName() {
    try {
      var selected = currentFileTreeDocument()
      if (selected) return selected.name
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

  // Additive adapter: TeXPage uses a different file tree and CRDT lifecycle.
  // The legacy Overleaf bibliography code below remains the default.
  var texpageBib = ${renderTexpageBibAdapter()}({
    fetch: function () { return originalFetch.apply(window, arguments) },
    editor: function () { return currentEditableBibEditor() },
    report: sendToParent,
  })
  var texpageTex = ${renderTexpageTexAdapter()}({
    fetch: function () { return originalFetch.apply(window, arguments) },
    editor: function () { return currentEditableBibEditor() },
    report: sendToParent,
  })

  /* fetch wrapper */
  var originalFetch = null
  if (typeof window.fetch === 'function') {
    originalFetch = window.fetch
    window.fetch = safe(function (input, init) {
      var rawUrl = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : (typeof Request === 'function' && input instanceof Request ? input.url : ''))
      var fetchMethod = String((init && init.method) || (typeof Request === 'function' && input instanceof Request ? input.method : 'GET')).toUpperCase()
      var requestGeneration = compileGeneration
      if (rawUrl !== '' && isCompilePost(rawUrl) && fetchMethod === 'POST') {
        requestGeneration = beginCompileGeneration('compiling')
      }
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
      if (rawUrl !== '' && pathnameOf(rawUrl).indexOf('/api/project/fileTree') !== -1) {
        routedResult.then(function (response) {
          if (!response.ok) return
          response.clone().json().then(function (json) {
            texpageBib.observe(routeUrl(rawUrl), json)
            texpageTex.observe(routeUrl(rawUrl), json)
          }).catch(function () {})
        }).catch(function () {})
      }
      // Compile-fix source: compile POST responses reveal output.log/.blg URLs;
      // an output.pdf load reveals the build path as a fallback.
      if (rawUrl !== '' && (isCompilePost(rawUrl) || isCachedCompileResponse(rawUrl))) {
        if ((isCompilePost(rawUrl) && fetchMethod === 'POST') || (isCachedCompileResponse(rawUrl) && fetchMethod === 'GET')) {
          routedResult
            .then(function (response) {
              try {
                response.clone().json()
                  .then(function (json) {
                    captureCompileResponse(json, isCompilePost(rawUrl) ? requestGeneration : undefined)
                  })
                  .catch(function () {})
              } catch (err) {
                if (DEBUG) log('compile clone failed', err)
              }
            })
            .catch(function () {})
        }
      } else if (rawUrl !== '' && isCompileLog(rawUrl)) {
        routedResult
          .then(function (response) { captureObservedLogResponse(response, rawUrl, requestGeneration) })
          .catch(function (err) {
            storeCompileLog({ path: compileLogPath(rawUrl), text: '', error: String(err) }, requestGeneration)
          })
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
        var xhrGeneration = compileGeneration
        if (rawUrl !== '' && isCompilePost(rawUrl) && String(method || 'GET').toUpperCase() === 'POST') {
          xhrGeneration = beginCompileGeneration('compiling')
        }
        if (typeof url === 'string') {
          arguments[1] = routeUrl(url)
        }
        if (typeof arguments[1] === 'string' && arguments[1].indexOf(PREFIX + '/__dsh_texpage_output__/') !== -1) {
          // Safe diagnostic only: never expose signed URLs, query values or
          // document bytes in the DOM/console.
          var outputStatusKey = /\\.pdf(?:[?#]|$)/.test(arguments[1]) ? 'pdf-status' : 'log-status'
          this.addEventListener('loadend', function () { markDiagnostic(outputStatusKey, this.status) })
        }
        // XHR backup for the compile-log source (some deployments/issues use
        // XHR for the compile POST - the fetch wrapper alone would miss them).
        if (rawUrl !== '' && typeof this.addEventListener === 'function') {
          try {
            var xhr = this
            xhr.addEventListener('readystatechange', function () {
              if (xhr.readyState !== 4) return
              try {
                if (xhr.status === 200 && pathnameOf(rawUrl).indexOf('/api/project/fileTree') !== -1) {
                  var treeJson = JSON.parse(xhr.responseText)
                  texpageBib.observe(routeUrl(rawUrl), treeJson)
                  texpageTex.observe(routeUrl(rawUrl), treeJson)
                }
                if ((isCompilePost(rawUrl) || isCachedCompileResponse(rawUrl)) && xhr.status === 200 && typeof xhr.responseText === 'string' && xhr.responseText !== '') {
                  var parsedPayload = JSON.parse(xhr.responseText)
                  if (parsedPayload) captureCompileResponse(parsedPayload, isCompilePost(rawUrl) ? xhrGeneration : undefined)
                } else if (isCompileLog(rawUrl)) {
                  if (xhr.status >= 200 && xhr.status < 300 && typeof xhr.responseText === 'string') {
                    storeCompileLog({ path: compileLogPath(rawUrl), text: truncateText(xhr.responseText, 1048576) }, xhrGeneration)
                  } else {
                    storeCompileLog({ path: compileLogPath(rawUrl), text: '', error: 'HTTP ' + xhr.status }, xhrGeneration)
                  }
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
  function routeSocketUrl(raw) {
    if (typeof raw !== 'string' && !(raw instanceof URL)) return raw
    var parsed = new URL(String(raw), window.location.href)
    if (!/^(?:https?|wss?):$/.test(parsed.protocol) || parsed.username || parsed.password) return raw
    var path = parsed.pathname
    var socketOrigin = window.__DSH_OVERLEAF_SOCKET_ORIGIN__
    var upstreamOrigin = window.__DSH_OVERLEAF_UPSTREAM_ORIGIN__
    var socketHost = typeof socketOrigin === 'string' ? new URL(socketOrigin).host : ''
    var upstreamHost = typeof upstreamOrigin === 'string' ? new URL(upstreamOrigin).host : ''
    if (socketHost !== '' && parsed.host === socketHost) {
      if (!/^\\/socket\\.io\\/?$/.test(path)) return raw
      path = '/__dsh_socket__' + path
    } else if (parsed.host !== window.location.host && parsed.host !== upstreamHost) {
      return raw
    }
    var port = parseInt(window.__DSH_OVERLEAF_WS_PORT__, 10) || 0
    var protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    if (port > 0) return protocol + '//127.0.0.1:' + port + path + parsed.search
    if (path.indexOf(PREFIX + '/') !== 0) path = PREFIX + path
    return protocol + '//' + window.location.host + path + parsed.search
  }
  try {
    var OriginalWebSocket = window.WebSocket
    if (typeof OriginalWebSocket === 'function') {
      var WS_PORT = parseInt(window.__DSH_OVERLEAF_WS_PORT__, 10) || 0
      markDiagnostic('ws-port', WS_PORT)
      function PatchedWebSocket(url, protocols) {
        try {
          url = routeSocketUrl(url)
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
        markDiagnostic('socketio-state', 'connecting')
        var messageCount = 0
        markDiagnostic('ws-messages', 0)
        var socket = new OriginalWebSocket(url, protocols)
        socket.addEventListener('open', function () { markDiagnostic('ws-state', 'open') })
        socket.addEventListener('message', function (event) {
          messageCount += 1
          markDiagnostic('ws-messages', messageCount)
          // Report protocol milestones, never payloads, session IDs or tokens.
          if (typeof event.data === 'string') {
            if (event.data.indexOf('40') === 0) markDiagnostic('socketio-state', 'connected')
            else if (event.data.indexOf('44') === 0) markDiagnostic('socketio-state', 'connect-error')
          }
        })
        socket.addEventListener('error', function () { markDiagnostic('ws-state', 'error') })
        socket.addEventListener('close', function (event) {
          markDiagnostic('ws-state', 'closed:' + String(event && event.code || 0))
          markDiagnostic('socketio-state', 'closed')
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
  var savedSelectionTargets = Object.create(null)
  var savedSelectionOrder = []
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
    savedSelectionTargets[savedSelection.id] = savedSelection
    savedSelectionOrder.push(savedSelection.id)
    while (savedSelectionOrder.length > 12) {
      var expiredId = savedSelectionOrder.shift()
      if (!savedSelection || expiredId !== savedSelection.id) delete savedSelectionTargets[expiredId]
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

  function replaceSavedEditorSelection(id, replacement, force) {
    var target = savedSelectionTargets[id]
    if (!target) {
      sendToParent({ type: 'selection-replace-done', ok: false, error: 'selection-expired' })
      return
    }
    try {
      if (!force && (!savedSelection || savedSelection.id !== id)) throw new Error('selection-stale')
      if (target.engine === 'cm5') {
        var cm5 = target.editor
        var doc5 = cm5 && String(cm5.getValue())
        if (!cm5 || !selectionEditorIsAttached(target)) throw new Error('selection-stale')
        if (!force && !replacementTargetStillMatches(target, doc5)) throw new Error('selection-stale')
        var from5 = Math.min(Math.max(0, target.from), doc5.length)
        var to5 = Math.min(Math.max(from5, target.to), doc5.length)
        rememberSnapshot(doc5)
        cm5.replaceRange(replacement, cm5.posFromIndex(from5), cm5.posFromIndex(to5))
        cm5.setCursor(cm5.posFromIndex(from5 + replacement.length))
        cm5.focus()
      } else if (target.engine === 'cm6') {
        var cm6 = target.editor
        var doc6 = cm6 && cm6.state.doc.toString()
        if (!cm6 || !selectionEditorIsAttached(target)) throw new Error('selection-stale')
        if (!force && !replacementTargetStillMatches(target, doc6)) throw new Error('selection-stale')
        var from6 = Math.min(Math.max(0, target.from), doc6.length)
        var to6 = Math.min(Math.max(from6, target.to), doc6.length)
        rememberSnapshot(doc6)
        cm6.dispatch({
          changes: { from: from6, to: to6, insert: replacement },
          selection: { anchor: from6 + replacement.length },
        })
        cm6.focus()
      } else {
        throw new Error('selection-engine-unavailable')
      }
      delete savedSelectionTargets[id]
      if (savedSelection && savedSelection.id === id) savedSelection = undefined
      sendToParent({ type: 'selection-replace-done', ok: true, engine: target.engine, forced: force === true })
    } catch (err) {
      sendToParent({ type: 'selection-replace-done', ok: false, error: err && err.message })
    }
  }

  /* Replace a project bibliography from an explicitly selected local file.
     The bridge resolves the Overleaf target by basename, opens it through the
     real file tree, waits for the matching editor tab, and then performs one
     whole-document CodeMirror transaction so Overleaf's normal collaboration
     and autosave pipeline observes the change. */
  function normalizeBibName(value) {
    return String(value || '').replace(/[\u200e\u200f]/g, '').trim()
  }

  function bibFileTreeRoot() {
    return document.querySelector('[data-testid="file-tree-list-root"]')
  }

  function prepareBibFileTree(done) {
    try {
      var fileTreeTab = document.getElementById('ide-rail-tabs-tab-file-tree')
      if (fileTreeTab && fileTreeTab.getAttribute('aria-selected') !== 'true') fileTreeTab.click()
    } catch (err) {}
    setTimeout(function () { expandBibFolders(0, done) }, 80)
  }

  function expandBibFolders(round, done) {
    var root = bibFileTreeRoot()
    if (!root) {
      if (round >= 20) { done(); return }
      setTimeout(function () { expandBibFolders(round + 1, done) }, 100)
      return
    }
    var collapsed = root.querySelectorAll('[role="treeitem"][aria-expanded="false"]')
    var clicked = 0
    for (var i = 0; i < collapsed.length; i++) {
      var button = collapsed[i].querySelector('.file-tree-entity-button')
      if (button) { button.click(); clicked += 1 }
    }
    if (clicked > 0 && round < 8) {
      setTimeout(function () { expandBibFolders(round + 1, done) }, 100)
      return
    }
    done()
  }

  function bibTreeCandidates() {
    var root = bibFileTreeRoot()
    if (!root) return []
    var items = root.querySelectorAll('[role="treeitem"][aria-label]')
    var found = []
    for (var i = 0; i < items.length; i++) {
      var name = normalizeBibName(items[i].getAttribute('aria-label'))
      if (!/\\.bib$/i.test(name)) continue
      var entity = items[i].querySelector('.entity[data-file-id][data-file-type="doc"]')
      if (!entity) continue
      found.push({ item: items[i], entity: entity, id: String(entity.getAttribute('data-file-id') || ''), name: name })
    }
    return found
  }

  function overleafOpenDocState(id) {
    try {
      var unstable = window.overleaf && window.overleaf.unstable
      var store = unstable && unstable.store
      if (!store || typeof store.get !== 'function') return 'unavailable'
      return String(store.get('editor.open_doc_id') || '') === id ? 'match' : 'mismatch'
    } catch (err) {
      return 'unavailable'
    }
  }

  function bibTreeTargetIsSelected(target) {
    try { return target.item && target.item.getAttribute('aria-selected') === 'true' }
    catch (err) { return false }
  }

  function cleanupBibOpenListener(target) {
    if (target && typeof target.cleanupOpened === 'function') {
      target.cleanupOpened()
      target.cleanupOpened = undefined
    }
  }

  function elementIsUsable(element) {
    try {
      if (!element || !document.documentElement.contains(element)) return false
      var style = window.getComputedStyle ? window.getComputedStyle(element) : undefined
      if (style && (style.display === 'none' || style.visibility === 'hidden')) return false
      return !element.getClientRects || element.getClientRects().length > 0
    } catch (err) {
      return false
    }
  }

  function editableCm5Candidates() {
    var found = []
    try {
      var holders = document.querySelectorAll('.CodeMirror')
      for (var i = 0; i < holders.length; i++) {
        var cm = holders[i].CodeMirror
        if (!cm || !elementIsUsable(holders[i])) continue
        try { if (cm.getOption && cm.getOption('readOnly')) continue } catch (err) {}
        if (found.indexOf(cm) < 0) found.push(cm)
      }
    } catch (err) {}
    return found
  }

  function editableCm6Candidates() {
    var found = []
    try {
      var storedView = undefined
      try {
        var unstable = window.overleaf && window.overleaf.unstable
        var store = unstable && unstable.store
        storedView = asEditorView(store && typeof store.get === 'function' ? store.get('editor.view') : undefined)
      } catch (err) {}
      var roots = document.querySelectorAll('.cm-editor')
      for (var i = 0; i < roots.length; i++) {
        var holder = roots[i]
        var content = holder.querySelector('.cm-content[contenteditable="true"]')
        if (!content || !elementIsUsable(holder) || !elementIsUsable(content)) continue
        if (String(content.getAttribute('aria-label') || '').toLowerCase() === 'visual preview') continue
        /* Current Overleaf/CodeMirror 6 stores a ContentView on the live
           .cm-content node. Its root view points at the EditorView. Older
           builds used .cm-editor/.cm-scroller expandos, so retain all paths. */
        var storedDom = storedView && (storedView.dom || storedView.contentDOM)
        var storedBelongsHere = storedDom && (storedDom === holder || holder.contains(storedDom) || storedDom === content)
        if (storedBelongsHere) return [storedView]
        var view = undefined
        view = view || asEditorView(content.cmView)
          || asEditorView(content.cmView && content.cmView.rootView)
          || asEditorView(holder.cmView)
          || asEditorView(holder.editor)
          || asEditorView(holder.parentNode && holder.parentNode.__codemirrorView)
        var inner = holder.querySelector('.cm-scroller')
        if (!view && inner) view = asEditorView(inner.cmView)
        /* Some optimized builds hide the expando on a descendant other than
           the root content node. Limit the fallback scan to this visible,
           editable editor so a Visual Preview can never win. */
        if (!view) {
          var nodes = holder.querySelectorAll('.cm-content, .cm-scroller')
          for (var n = 0; n < nodes.length && !view; n++) {
            var keys = Object.keys(nodes[n] || {})
            for (var k = 0; k < keys.length; k++) {
              var value = null
              try { value = nodes[n][keys[k]] } catch (err) { continue }
              view = asEditorView(value)
              if (view) break
              try { view = asEditorView(value && value.rootView) } catch (err2) {}
              if (view) break
            }
          }
        }
        if (view && found.indexOf(view) < 0) found.push(view)
      }
    } catch (err) {}
    return found
  }

  function currentEditableBibEditor() {
    var cm5 = editableCm5Candidates()
    var cm6 = editableCm6Candidates()
    if (cm5.length + cm6.length !== 1) return { error: cm5.length + cm6.length === 0 ? 'bib-editor-unavailable' : 'bib-editor-ambiguous' }
    return cm5.length === 1 ? { engine: 'cm5', editor: cm5[0] } : { engine: 'cm6', editor: cm6[0] }
  }

  function bibEventDocId(event) {
    try {
      var detail = event && event.detail
      return String((detail && (detail.id || detail.docId || detail.doc_id)) || '')
    } catch (err) {
      return ''
    }
  }

  function listenForBibEvent(type, docId, done) {
    var finished = false
    var handler = function (event) {
      if (bibEventDocId(event) !== docId) return
      cleanup()
      done()
    }
    function cleanup() {
      if (finished) return
      finished = true
      window.removeEventListener(type, handler)
      document.removeEventListener(type, handler)
    }
    window.addEventListener(type, handler)
    document.addEventListener(type, handler)
    return cleanup
  }

  function rememberBibSnapshot(target, engine, docValue) {
    try {
      var projectMatch = /\\/project\\/([^/?#]+)/.exec(location.pathname)
      var projectId = projectMatch ? projectMatch[1] : 'unknown-project'
      var key = 'dsh-overleaf:bib-snapshot:' + projectId + ':' + target.id
      var value = JSON.stringify({
        time: Date.now(), projectId: projectId, docId: target.id,
        path: target.name, engine: engine, doc: docValue,
      })
      window.localStorage.setItem(key, value)
      if (window.localStorage.getItem(key) !== value) throw new Error('snapshot verification failed')
      sendToParent({ type: 'snapshot-saved' })
      return true
    } catch (err) {
      if (DEBUG) log('bibliography snapshot failed', err)
      return false
    }
  }

  function waitForBibSave(target, content, cleanupSaveListener, savedState, attempt) {
    if (savedState.done) {
      cleanupSaveListener()
      sendToParent({ type: 'bib-sync-done', ok: true, target: target.name, chars: content.length })
      return
    }
    if (attempt >= 120) {
      cleanupSaveListener()
      sendToParent({ type: 'bib-sync-done', ok: false, error: 'bib-save-timeout', target: target.name })
      return
    }
    setTimeout(function () { waitForBibSave(target, content, cleanupSaveListener, savedState, attempt + 1) }, 100)
  }

  function applyBibToSelectedEditor(target, content) {
    var cleanupSaveListener
    try {
      var openState = overleafOpenDocState(target.id)
      var identityReady = openState === 'match'
        || (openState === 'unavailable' && (target.opened || target.initiallySelected) && bibTreeTargetIsSelected(target))
      if (!identityReady) {
        if (Date.now() >= target.openDeadline) throw new Error('bib-editor-timeout')
        setTimeout(function () { applyBibToSelectedEditor(target, content) }, 100)
        return
      }
      cleanupBibOpenListener(target)
      if (!target.editorDeadline) target.editorDeadline = Date.now() + 8000
      var selected = currentEditableBibEditor()
      if (selected.error) {
        if (Date.now() >= target.editorDeadline) throw new Error(selected.error)
        setTimeout(function () { applyBibToSelectedEditor(target, content) }, 100)
        return
      }
      var savedState = { done: false }
      cleanupSaveListener = listenForBibEvent('doc:saved', target.id, function () { savedState.done = true })
      if (selected.engine === 'cm5') {
        var cm5 = selected.editor
        var old5 = String(cm5.getValue())
        if (old5 === content) {
          cleanupSaveListener()
          sendToParent({ type: 'bib-sync-done', ok: true, target: target.name, chars: content.length, unchanged: true })
          return
        }
        if (!rememberBibSnapshot(target, 'cm5', old5)) throw new Error('bib-snapshot-failed')
        if (typeof cm5.operation === 'function') {
          cm5.operation(function () { cm5.replaceRange(content, cm5.posFromIndex(0), cm5.posFromIndex(old5.length)) })
        } else {
          cm5.replaceRange(content, cm5.posFromIndex(0), cm5.posFromIndex(old5.length))
        }
        if (String(cm5.getValue()) !== content) throw new Error('bib-write-verification-failed')
        cm5.setCursor(cm5.posFromIndex(content.length))
        cm5.focus()
        waitForBibSave(target, content, cleanupSaveListener, savedState, 0)
        return
      }
      if (selected.engine === 'cm6') {
        var cm6 = selected.editor
        var old6 = cm6.state.doc.toString()
        if (old6 === content) {
          cleanupSaveListener()
          sendToParent({ type: 'bib-sync-done', ok: true, target: target.name, chars: content.length, unchanged: true })
          return
        }
        if (!rememberBibSnapshot(target, 'cm6', old6)) throw new Error('bib-snapshot-failed')
        cm6.dispatch({
          changes: { from: 0, to: old6.length, insert: content },
          selection: { anchor: content.length },
        })
        if (cm6.state.doc.toString() !== content) throw new Error('bib-write-verification-failed')
        cm6.focus()
        waitForBibSave(target, content, cleanupSaveListener, savedState, 0)
        return
      }
    } catch (err) {
      cleanupBibOpenListener(target)
      if (typeof cleanupSaveListener === 'function') cleanupSaveListener()
      sendToParent({ type: 'bib-sync-done', ok: false, error: err && err.message ? err.message : String(err) })
    }
  }

  function syncBibFile(fileName, content) {
    if (typeof texpageBib !== 'undefined' && texpageBib.enabled()) {
      texpageBib.sync(fileName, content)
      return
    }
    var requested = normalizeBibName(fileName)
    if (!/\\.bib$/i.test(requested)) {
      sendToParent({ type: 'bib-sync-done', ok: false, error: 'bib-invalid-name' })
      return
    }
    prepareBibFileTree(function () {
      try {
        var all = bibTreeCandidates()
        var exact = all.filter(function (candidate) { return candidate.name === requested })
        var insensitive = all.filter(function (candidate) { return candidate.name.toLowerCase() === requested.toLowerCase() })
        var matches = exact.length > 0 ? exact : insensitive
        var target = matches.length === 1 ? matches[0] : undefined
        if (!target) {
          var names = all.map(function (candidate) { return candidate.name }).join(', ')
          var reason = matches.length > 1 ? 'bib-target-ambiguous' : 'bib-target-missing'
          sendToParent({ type: 'bib-sync-done', ok: false, error: reason, available: names })
          return
        }
        target.initiallySelected = bibTreeTargetIsSelected(target)
        target.opened = false
        target.openDeadline = Date.now() + 10000
        target.editorDeadline = 0
        target.cleanupOpened = listenForBibEvent('doc:after-opened', target.id, function () {
          target.opened = true
          cleanupBibOpenListener(target)
        })
        if (!target.initiallySelected) target.entity.click()
        applyBibToSelectedEditor(target, String(content || ''))
      } catch (err) {
        cleanupBibOpenListener(typeof target === 'undefined' ? undefined : target)
        sendToParent({ type: 'bib-sync-done', ok: false, error: err && err.message ? err.message : String(err) })
      }
    })
  }

  /* Bidirectional current .tex synchronization. Overleaf-to-local reads the
     single visible source editor. Local-to-Overleaf is deliberately stricter:
     it requires an explicit confirmation bit, a stable current document id,
     a pre-change snapshot, write verification, and doc:saved confirmation. */
  function utf8TextSize(value) {
    try { return new TextEncoder().encode(String(value || '')).length }
    catch (err) { return String(value || '').length }
  }

  function texRevision(value) {
    var text = String(value || '')
    var hash = 2166136261
    for (var i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i)
      hash = Math.imul(hash, 16777619)
    }
    return text.length + '-' + (hash >>> 0).toString(16)
  }

  function currentTexIdentity() {
    var selected = currentFileTreeDocument()
    if (!selected) throw new Error('tex-document-identity-unavailable')
    var storeId = ''
    try {
      var unstable = window.overleaf && window.overleaf.unstable
      var store = unstable && unstable.store
      if (store && typeof store.get === 'function') storeId = String(store.get('editor.open_doc_id') || '')
    } catch (err) {}
    if (storeId !== '' && selected.id !== storeId) throw new Error('tex-document-identity-mismatch')
    if (!/\.tex$/i.test(selected.name)) throw new Error('tex-current-document-not-tex')
    if (selected.id === '') throw new Error('tex-document-id-unavailable')
    return { id: selected.id, name: selected.name, selected: selected }
  }

  function currentTexEditorValue() {
    var selected = currentEditableBibEditor()
    if (selected.error) throw new Error(selected.error.replace(/^bib-/, 'tex-'))
    if (selected.engine === 'cm5') return { engine: 'cm5', editor: selected.editor, text: String(selected.editor.getValue()) }
    if (selected.engine === 'cm6') return { engine: 'cm6', editor: selected.editor, text: selected.editor.state.doc.toString() }
    throw new Error('tex-editor-unavailable')
  }

  function emitCurrentTexDocument(requestId) {
    if (typeof texpageTex !== 'undefined' && texpageTex.enabled()) {
      texpageTex.emit(requestId)
      return
    }
    try {
      var identity = currentTexIdentity()
      var current = currentTexEditorValue()
      if (utf8TextSize(current.text) > 4 * 1024 * 1024) throw new Error('tex-document-too-large')
      sendToParent({ type: 'tex-document', requestId: requestId, ok: true, id: identity.id, name: identity.name, text: current.text, revision: texRevision(current.text) })
    } catch (err) {
      sendToParent({ type: 'tex-document', requestId: requestId, ok: false, error: err && err.message ? err.message : String(err) })
    }
  }

  function rememberTexSnapshot(identity, engine, docValue) {
    try {
      var projectMatch = /\\/project\\/([^/?#]+)/.exec(location.pathname)
      var projectId = projectMatch ? projectMatch[1] : 'unknown-project'
      var key = 'dsh-overleaf:tex-snapshot:' + projectId + ':' + identity.id
      var value = JSON.stringify({
        time: Date.now(), projectId: projectId, docId: identity.id,
        path: identity.name, engine: engine, doc: docValue,
      })
      window.localStorage.setItem(key, value)
      if (window.localStorage.getItem(key) !== value) throw new Error('snapshot verification failed')
      sendToParent({ type: 'snapshot-saved' })
      return true
    } catch (err) {
      if (DEBUG) log('tex snapshot failed', err)
      return false
    }
  }

  var texSyncBusyRequestId = ''

  function waitForTexSave(identity, content, requestId, cleanupSaveListener, savedState, attempt) {
    if (savedState.done) {
      cleanupSaveListener()
      texSyncBusyRequestId = ''
      sendToParent({ type: 'tex-overleaf-sync-done', requestId: requestId, ok: true, target: identity.name, chars: content.length })
      return
    }
    if (attempt >= 120) {
      cleanupSaveListener()
      texSyncBusyRequestId = ''
      sendToParent({ type: 'tex-overleaf-sync-done', requestId: requestId, ok: false, error: 'tex-save-timeout', target: identity.name })
      return
    }
    setTimeout(function () { waitForTexSave(identity, content, requestId, cleanupSaveListener, savedState, attempt + 1) }, 100)
  }

  function syncTexToOverleaf(content, confirmed, requestId, expectedDocId, expectedRevision) {
    if (typeof texpageTex !== 'undefined' && texpageTex.enabled()) {
      texpageTex.sync(content, confirmed, requestId, expectedDocId, expectedRevision)
      return
    }
    var cleanupSaveListener
    try {
      if (texSyncBusyRequestId !== '') throw new Error('tex-sync-busy')
      texSyncBusyRequestId = requestId || 'unknown-request'
      if (confirmed !== true) throw new Error('tex-reverse-confirmation-required')
      var text = String(content || '')
      if (utf8TextSize(text) > 4 * 1024 * 1024) throw new Error('tex-document-too-large')
      var identity = currentTexIdentity()
      var current = currentTexEditorValue()
      if (String(expectedDocId || '') !== identity.id || String(expectedRevision || '') !== texRevision(current.text)) {
        throw new Error('tex-remote-changed')
      }
      if (current.text === text) {
        texSyncBusyRequestId = ''
        sendToParent({ type: 'tex-overleaf-sync-done', requestId: requestId, ok: true, target: identity.name, chars: text.length, unchanged: true })
        return
      }
      if (!rememberTexSnapshot(identity, current.engine, current.text)) throw new Error('tex-snapshot-failed')
      var savedState = { done: false }
      cleanupSaveListener = listenForBibEvent('doc:saved', identity.id, function () { savedState.done = true })
      if (current.engine === 'cm5') {
        var cm5 = current.editor
        if (typeof cm5.operation === 'function') {
          cm5.operation(function () { cm5.replaceRange(text, cm5.posFromIndex(0), cm5.posFromIndex(current.text.length)) })
        } else {
          cm5.replaceRange(text, cm5.posFromIndex(0), cm5.posFromIndex(current.text.length))
        }
        if (String(cm5.getValue()) !== text) throw new Error('tex-write-verification-failed')
        cm5.setCursor(cm5.posFromIndex(text.length))
        cm5.focus()
      } else if (current.engine === 'cm6') {
        var cm6 = current.editor
        cm6.dispatch({
          changes: { from: 0, to: current.text.length, insert: text },
          selection: { anchor: text.length },
        })
        if (cm6.state.doc.toString() !== text) throw new Error('tex-write-verification-failed')
        cm6.focus()
      }
      waitForTexSave(identity, text, requestId, cleanupSaveListener, savedState, 0)
    } catch (err) {
      if (typeof cleanupSaveListener === 'function') cleanupSaveListener()
      texSyncBusyRequestId = ''
      sendToParent({ type: 'tex-overleaf-sync-done', requestId: requestId, ok: false, error: err && err.message ? err.message : String(err) })
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
      replaceSavedEditorSelection(String(data.selectionId || ''), String(data.text || ''), data.force === true)
      return
    }
    if (data.type === 'sync-bib') {
      syncBibFile(String(data.fileName || ''), String(data.text || ''))
      return
    }
    if (data.type === 'tex-document-request') {
      emitCurrentTexDocument(String(data.requestId || ''))
      return
    }
    if (data.type === 'sync-tex-to-overleaf') {
      syncTexToOverleaf(String(data.text || ''), data.confirmed === true, String(data.requestId || ''), String(data.expectedDocId || ''), String(data.expectedRevision || ''))
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
      revealText(String(data.query || ''), Number.isFinite(Number(data.line)) ? Number(data.line) : undefined)
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
      /* The active editor selection was cleared or moved away. Keep its
         bounded history entry for explicit force mode, but make safe mode
         reject it as no longer current. */
      savedSelection = undefined
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

  function revealText(query, lineNumber) {
    try {
      if (!query && lineNumber === undefined) return
      var needle = query ? query.replace(/^\\n+|\\n+$/g, '').slice(0, 200) : ''
      var cm5 = findCm5()
      if (cm5) {
        var doc = String(cm5.getValue())
        var index = -1
        if (lineNumber !== undefined && cm5.getLineHandle) {
          var lineText = cm5.getLine(lineNumber)
          /* Line numbers in the outline are 0-based; CM5 getLine expects the
             same 0-based index, so the match must be exact. Double-check the
             text still corresponds, then fall through to string search. */
          if (lineText && needle.indexOf(lineText) !== -1) {
            try { index = cm5.indexFromPos({ line: lineNumber, ch: 0 }) } catch (err) { index = -1 }
          }
        }
        if (index < 0 && needle) index = doc.indexOf(needle)
        if (index >= 0) {
          var from = cm5.posFromIndex(index)
          var to = cm5.posFromIndex(index + Math.max(1, Math.min(needle.length || lineText.length || 1, 400)))
          cm5.setSelection(from, to)
          cm5.scrollIntoView({ from: from, to: to }, 160)
          cm5.focus()
          return
        }
      }
      /* CM6: the editor text lives in a virtualized CodeMirror document, so
         the raw line is not reachable through a DOM text-node walker. Locate
         it in state.doc (by line number first, then string), move the cursor
         there, then scroll the scroller. */
      var cm6 = findCm6()
      if (cm6) {
        var doc6 = cm6.state.doc.toString()
        var index6 = -1
        if (lineNumber !== undefined && cm6.state.doc && typeof cm6.state.doc.line === 'function') {
          try {
            var line6 = cm6.state.doc.line(lineNumber)
            if (line6 && line6.from !== undefined) index6 = line6.from
          } catch (err) { index6 = -1 }
        }
        if (index6 < 0 && needle) index6 = doc6.indexOf(needle)
        if (index6 >= 0) {
          var len = Math.max(1, Math.min(needle.length || 1, 400))
          cm6.dispatch({ selection: { anchor: index6, head: index6 + len } })
          cm6.focus()
          var scroller = cm6.dom && cm6.dom.closest ? cm6.dom.closest('.cm-scroller') : null
          var anchor = scroller || (cm6.dom || null)
          if (anchor && typeof anchor.scrollIntoView === 'function') {
            anchor.scrollIntoView({ block: 'center', behavior: 'smooth' })
          }
          return
        }
      }
      /* DOM-wide soft match otherwise */
      if (!needle) return
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
const inject = [
	"webServer",
	"credentials",
	"sessions"
];
const MAX_TEX_FILE_BYTES = 4194304;
const MAX_REQUEST_BYTES = 65536;
const MAX_TEX_REQUEST_BYTES = 25231360;
const MAX_BIB_FILE_BYTES = 2097152;
const MAX_BIB_RESULTS = 50;
const MAX_BIB_SCAN_DEPTH = 8;
const MAX_TEX_RESULTS = 100;
const MAX_TEX_SCAN_DEPTH = 8;
const BIB_SCAN_IGNORED_DIRS = /* @__PURE__ */ new Set([
	".git",
	".hg",
	".svn",
	".dsh-meow",
	".tmp",
	"node_modules",
	"dist",
	"build",
	"coverage",
	"fixtures"
]);
const LOOPBACK_ADDRESSES = /* @__PURE__ */ new Set([
	"127.0.0.1",
	"::1",
	"::ffff:127.0.0.1"
]);
function isLoopback(req) {
	return req.socket.remoteAddress === void 0 || LOOPBACK_ADDRESSES.has(req.socket.remoteAddress);
}
async function readJsonBody(req, maxBytes = MAX_REQUEST_BYTES) {
	const chunks = [];
	let bytes = 0;
	for await (const chunk of req) {
		const buffer = chunk;
		bytes += buffer.byteLength;
		if (bytes > maxBytes) throw new Error("dsh-overleaf: request body too large");
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
function isWithinWorkspace(root, target) {
	const relative$1 = relative(root, target);
	return relative$1 === "" || relative$1 !== ".." && !relative$1.startsWith(`..${sep}`) && !isAbsolute(relative$1);
}
async function canonicalWorkspaceRoot(cwd) {
	const rawRoot = cwd.trim();
	if (rawRoot === "" || !isAbsolute(rawRoot)) throw new Error("dsh-overleaf: bibliography sync requires an absolute session workspace");
	const root = await realpath(rawRoot).catch(() => void 0);
	if (root === void 0) throw new Error("dsh-overleaf: session workspace does not exist");
	const rootStats = await stat(root).catch(() => void 0);
	if (rootStats === void 0 || !rootStats.isDirectory()) throw new Error("dsh-overleaf: session workspace is not a directory");
	return root;
}
/** Discover UTF-8 BibTeX candidates inside one trusted DSH workspace. */
async function discoverWorkspaceBibFiles(cwd) {
	const root = await canonicalWorkspaceRoot(cwd);
	const found = [];
	const queue = [{
		dir: root,
		depth: 0
	}];
	while (queue.length > 0 && found.length < MAX_BIB_RESULTS) {
		const current = queue.shift();
		if (current === void 0) break;
		const entries = await readdir(current.dir, { withFileTypes: true }).catch(() => []);
		entries.sort((left, right) => left.name.localeCompare(right.name));
		for (const entry of entries) {
			if (found.length >= MAX_BIB_RESULTS) break;
			const fullPath = join(current.dir, entry.name);
			if (entry.isFile() && extname(entry.name).toLowerCase() === ".bib") found.push(fullPath);
			else if (entry.isDirectory() && current.depth < MAX_BIB_SCAN_DEPTH && !BIB_SCAN_IGNORED_DIRS.has(entry.name.toLowerCase())) queue.push({
				dir: fullPath,
				depth: current.depth + 1
			});
		}
	}
	return found;
}
/** Resolve and read one explicit .bib, refusing traversal and symlink escapes. */
async function readLocalBibFile(cwd, requestedPath) {
	const rawPath = requestedPath.trim();
	if (rawPath === "" || rawPath.includes("\0")) throw new Error("dsh-overleaf: a .bib path is required");
	const root = await canonicalWorkspaceRoot(cwd);
	const requestedTarget = resolve(isAbsolute(rawPath) ? rawPath : join(root, rawPath));
	if (!isWithinWorkspace(root, requestedTarget)) throw new Error("dsh-overleaf: the .bib file must be inside the current session workspace");
	if (extname(requestedTarget).toLowerCase() !== ".bib") throw new Error("dsh-overleaf: only .bib files can be synchronized");
	const target = await realpath(requestedTarget).catch(() => void 0);
	if (target === void 0) throw new Error(`dsh-overleaf: .bib file not found: ${requestedTarget}`);
	if (!isWithinWorkspace(root, target)) throw new Error("dsh-overleaf: the .bib file resolves outside the current session workspace");
	if (extname(target).toLowerCase() !== ".bib") throw new Error("dsh-overleaf: only .bib files can be synchronized");
	const stats = await stat(target).catch(() => void 0);
	if (stats === void 0 || !stats.isFile()) throw new Error(`dsh-overleaf: .bib file not found: ${target}`);
	if (stats.size > MAX_BIB_FILE_BYTES) throw new Error("dsh-overleaf: .bib file exceeds the 2 MiB safety limit");
	const content = await readFile(target, "utf8");
	return {
		path: target,
		name: basename(target),
		content,
		mtimeMs: stats.mtimeMs,
		size: stats.size
	};
}
/** Discover local LaTeX sources without following directory symlinks. */
async function discoverWorkspaceTexFiles(cwd) {
	const root = await canonicalWorkspaceRoot(cwd);
	const found = [];
	const queue = [{
		dir: root,
		depth: 0
	}];
	while (queue.length > 0 && found.length < MAX_TEX_RESULTS) {
		const current = queue.shift();
		if (current === void 0) break;
		const entries = await readdir(current.dir, { withFileTypes: true }).catch(() => []);
		entries.sort((left, right) => left.name.localeCompare(right.name));
		for (const entry of entries) {
			if (found.length >= MAX_TEX_RESULTS) break;
			const fullPath = join(current.dir, entry.name);
			if (entry.isFile() && extname(entry.name).toLowerCase() === ".tex") found.push(fullPath);
			else if (entry.isDirectory() && current.depth < MAX_TEX_SCAN_DEPTH && !BIB_SCAN_IGNORED_DIRS.has(entry.name.toLowerCase())) queue.push({
				dir: fullPath,
				depth: current.depth + 1
			});
		}
	}
	return found;
}
function safeTexFallbackName(value) {
	const name = basename(value.replace(/[\u200e\u200f]/g, "").trim());
	if (name === "" || name === "." || name === ".." || extname(name).toLowerCase() !== ".tex") throw new Error("dsh-overleaf: the current Overleaf document must have a valid .tex filename");
	return name;
}
/** Resolve one local .tex target; an empty path uses safe auto-selection. */
async function resolveWorkspaceTexPath(cwd, requestedPath, fallbackName, createWhenMissing) {
	const root = await canonicalWorkspaceRoot(cwd);
	const rawPath = requestedPath.trim();
	let target;
	if (rawPath !== "") {
		if (rawPath.includes("\0")) throw new Error("dsh-overleaf: invalid .tex path");
		target = resolve(isAbsolute(rawPath) ? rawPath : join(root, rawPath));
	} else {
		const safeName = safeTexFallbackName(fallbackName);
		const candidates = await discoverWorkspaceTexFiles(root);
		const exact = candidates.filter((path) => basename(path) === safeName);
		const insensitive = candidates.filter((path) => basename(path).toLowerCase() === safeName.toLowerCase());
		const matches = exact.length > 0 ? exact : insensitive;
		if (matches.length === 1) target = matches[0];
		else if (matches.length > 1) throw new Error("dsh-overleaf: multiple local .tex files have the same name; choose a path explicitly");
		else if (candidates.length > 0) throw new Error("dsh-overleaf: no same-named local .tex file was found; choose a path explicitly");
		else if (createWhenMissing) target = join(root, safeName);
		else throw new Error("dsh-overleaf: no local .tex file was detected; choose a path or provide manual content");
	}
	if (!isWithinWorkspace(root, target)) throw new Error("dsh-overleaf: the .tex file must be inside the current session workspace");
	if (extname(target).toLowerCase() !== ".tex") throw new Error("dsh-overleaf: only .tex files can be synchronized");
	return {
		root,
		target
	};
}
/** Read one workspace .tex for the explicitly confirmed reverse direction. */
async function readLocalTexFile(cwd, requestedPath, fallbackName = "current.tex") {
	const resolved = await resolveWorkspaceTexPath(cwd, requestedPath, fallbackName, false);
	const target = await realpath(resolved.target).catch(() => void 0);
	if (target === void 0) throw new Error(`dsh-overleaf: .tex file not found: ${resolved.target}`);
	if (!isWithinWorkspace(resolved.root, target)) throw new Error("dsh-overleaf: the .tex file resolves outside the current session workspace");
	if (extname(target).toLowerCase() !== ".tex") throw new Error("dsh-overleaf: the .tex file resolves to a non-.tex target");
	const stats = await stat(target).catch(() => void 0);
	if (stats === void 0 || !stats.isFile()) throw new Error(`dsh-overleaf: .tex file not found: ${target}`);
	if (stats.size > MAX_TEX_FILE_BYTES) throw new Error("dsh-overleaf: .tex file exceeds the 4 MiB safety limit");
	const content = await readFile(target, "utf8");
	return {
		path: target,
		name: basename(target),
		content,
		mtimeMs: stats.mtimeMs,
		size: stats.size
	};
}
/**
* Write an Overleaf source snapshot into the workspace and verify the exact
* UTF-8 content. On a failed write/readback, restore the previous file (or
* remove the newly-created partial file) before reporting failure.
*/
async function writeLocalTexFile(cwd, requestedPath, fallbackName, content) {
	if (Buffer.byteLength(content, "utf8") > MAX_TEX_FILE_BYTES) throw new Error("dsh-overleaf: .tex content exceeds the 4 MiB safety limit");
	const resolved = await resolveWorkspaceTexPath(cwd, requestedPath, fallbackName, true);
	const existingReal = await realpath(resolved.target).catch(() => void 0);
	if (existingReal !== void 0 && !isWithinWorkspace(resolved.root, existingReal)) throw new Error("dsh-overleaf: the .tex file resolves outside the current session workspace");
	const target = existingReal ?? resolved.target;
	if (extname(target).toLowerCase() !== ".tex") throw new Error("dsh-overleaf: the .tex file resolves to a non-.tex target");
	const parent = await realpath(dirname(target)).catch(() => void 0);
	if (parent === void 0 || !isWithinWorkspace(resolved.root, parent)) throw new Error("dsh-overleaf: the .tex parent directory must already exist inside the workspace");
	const previousStats = await stat(target).catch(() => void 0);
	if (previousStats !== void 0 && !previousStats.isFile()) throw new Error("dsh-overleaf: the selected .tex target is not a regular file");
	if (previousStats !== void 0 && previousStats.size > MAX_TEX_FILE_BYTES) throw new Error("dsh-overleaf: existing .tex file exceeds the 4 MiB safety limit");
	const previous = previousStats === void 0 ? void 0 : await readFile(target, "utf8");
	if (previous === content) return {
		path: target,
		name: basename(target),
		mtimeMs: previousStats.mtimeMs,
		size: previousStats.size,
		created: false,
		unchanged: true
	};
	try {
		await writeFile(target, content, "utf8");
		if (await readFile(target, "utf8") !== content) throw new Error("write verification failed");
	} catch (error) {
		if (previous !== void 0) await writeFile(target, previous, "utf8").catch(() => void 0);
		else await unlink(target).catch(() => void 0);
		throw new Error(`dsh-overleaf: local .tex write failed and was rolled back: ${error instanceof Error ? error.message : String(error)}`);
	}
	const nextStats = await stat(target);
	return {
		path: target,
		name: basename(target),
		mtimeMs: nextStats.mtimeMs,
		size: nextStats.size,
		created: previousStats === void 0,
		unchanged: false
	};
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
		"settings",
		"sessions"
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
		this.rawConfig = config;
		this.config = resolveConfig(config);
		this.proxy = new ReverseProxy(this.config.baseUrl);
		this.bridgeScript = renderBridgeScript();
		this.proxy.injectScriptSrc = this.config.injectScriptEnabled ? "/overleaf/workbench/bridge.js" : void 0;
		this.refreshCredential().catch((error) => ctx.logger?.warn?.(`dsh-overleaf: credential probe failed: ${error instanceof Error ? error.message : String(error)}`));
		this.registerRoutes();
		this.registerSettingsIntegration();
		this.startWsTunnel();
	}
	/** Resolve the workspace from server-owned session metadata, never client input. */
	workspaceForPayload(payload) {
		const sessionId = stringField(payload, "sessionId");
		if (sessionId === void 0 || sessionId.trim() === "") throw new Error("dsh-overleaf: workspace synchronization requires a sessionId");
		const cwd = this.ctx.sessions.get(sessionId)?.header.cwd;
		if (cwd === void 0 || cwd.trim() === "") throw new Error("dsh-overleaf: the active session has no workspace");
		return cwd;
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
	/**
	* The loader-resolved config container. Its `.volatile()` fields are live
	* references (`{ get() }`) that the Loader mutates in place, so re-resolving
	* this same object always yields the current values.
	*/
	rawConfig;
	/**
	* DSH 0.1.7+ settings integration.
	*
	* The Loader projects a plugin's Config into the settings forms, but ONLY its
	* `.volatile()` fields: `dsh-settings`' `volatileForm()` returns undefined for
	* a schema without one, after which `describe()` omits the entry entirely and
	* no client page or transport write can address it. With volatile fields
	* present, a save commits those references in place and the Loader emits
	* `loader/volatile-update` on this fiber instead of remounting the plugin —
	* that event is the cue to re-resolve and hot-swap the proxy, so baseUrl and
	* feature edits apply without a restart.
	*
	* `configure({ auto: false })` declares that this plugin ships its own page
	* (the client half registers into the Plugins page's keyed seats), which
	* suppresses any schema-generated page. Everything here degrades silently on
	* harness generations without these services.
	*/
	registerSettingsIntegration() {
		if (typeof this.ctx.inject === "function") try {
			this.ctx.inject(["settings"], (child) => {
				try {
					const settings = child.settings;
					if (settings?.configure === void 0) return;
					const configure = settings.configure.bind(settings);
					child.effect(() => configure({ auto: false }, this.ctx.fiber), "dsh-overleaf: settings page policy");
				} catch (error) {
					console.warn("[dsh-overleaf] settings page policy skipped:", error instanceof Error ? error.message : error);
				}
			});
		} catch (error) {
			console.warn("[dsh-overleaf] settings service unavailable:", error instanceof Error ? error.message : error);
		}
		try {
			this.ctx.on?.("loader/volatile-update", () => {
				try {
					this.applyRuntimeConfig(resolveConfig(this.rawConfig));
				} catch (error) {
					console.warn("[dsh-overleaf] live settings application failed:", error instanceof Error ? error.message : error);
				}
			});
		} catch (error) {
			console.warn("[dsh-overleaf] volatile-update subscription skipped:", error instanceof Error ? error.message : error);
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
	route(path, run, maxRequestBytes = MAX_REQUEST_BYTES) {
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
						value: await run(await readJsonBody(req, maxRequestBytes) ?? {})
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
		this.route("/overleaf/workbench/bib-files", async (payload) => {
			return { files: await discoverWorkspaceBibFiles(this.workspaceForPayload(payload)) };
		});
		this.route("/overleaf/workbench/read-bib-file", async (payload) => {
			const path = stringField(payload, "path");
			if (path === void 0) throw new Error("dsh-overleaf: read-bib-file requires a path");
			return await readLocalBibFile(this.workspaceForPayload(payload), path);
		});
		this.route("/overleaf/workbench/tex-files", async (payload) => {
			return { files: await discoverWorkspaceTexFiles(this.workspaceForPayload(payload)) };
		});
		this.route("/overleaf/workbench/read-tex-file", async (payload) => {
			const path = stringField(payload, "path") ?? "";
			const fallbackName = stringField(payload, "fallbackName") ?? "current.tex";
			return await readLocalTexFile(this.workspaceForPayload(payload), path, fallbackName);
		});
		this.route("/overleaf/workbench/write-tex-file", async (payload) => {
			const path = stringField(payload, "path") ?? "";
			const fallbackName = stringField(payload, "fallbackName");
			const content = stringField(payload, "content");
			if (fallbackName === void 0) throw new Error("dsh-overleaf: write-tex-file requires a fallbackName");
			if (content === void 0) throw new Error("dsh-overleaf: write-tex-file requires text content");
			return await writeLocalTexFile(this.workspaceForPayload(payload), path, fallbackName, content);
		}, MAX_TEX_REQUEST_BYTES);
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
			"/socket.io",
			"/overleaf-proxy/__dsh_socket__/socket.io/",
			"/overleaf-proxy/__dsh_socket__/socket.io"
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
export { BRIDGE_SCRIPT_NAME, Config, OVERLEAF_WORKBENCH_COOKIE, OverleafWorkbenchService, OverleafWorkbenchService as default, PROXY_PREFIX, ReverseProxy, allowSelfInCsp, buildUpstreamHeaders, discoverWorkspaceBibFiles, discoverWorkspaceTexFiles, extractContentDomainFromHtml, extractContentHintsFromJson, extractCspNonce, inject, loginViaCdp, mergeCookieHeaders, mergeProxyCookieHeaders, name, normalizeOrigin, persistentLoginProfileDir, projectsFromDashboardHtml, readLocalBibFile, readLocalTexFile, relaxFrameCsp, renderBridgeScript, requestTimeoutFor, resolveConfig, rewriteCss, rewriteHtml, scopeSetCookieToHost, subPathOf, writeLocalTexFile };
