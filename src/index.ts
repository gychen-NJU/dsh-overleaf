/**
 * dsh-overleaf package root (host half). The default export is the Cordis
 * Service class the web composition mounts as the `overleaf-workbench` row.
 * @module dsh-overleaf
 */
export {
  Config, OverleafWorkbenchService, name, inject,
  projectsFromDashboardHtml,
} from './service.ts'
export { default } from './service.ts'
export type { WorkbenchConfig, ResolvedConfig, LoginProfileMode, OverleafBrowserChannel } from './config.ts'
export { normalizeOrigin, resolveConfig } from './config.ts'
export { OVERLEAF_WORKBENCH_COOKIE } from './credentials.ts'
export { PROXY_PREFIX, ReverseProxy, allowSelfInCsp, buildUpstreamHeaders, mergeCookieHeaders, rewriteHtml, relaxFrameCsp, scopeSetCookieToHost, subPathOf } from './proxy.ts'
export { renderBridgeScript, BRIDGE_SCRIPT_NAME } from './inject-script.ts'
export { loginViaCdp, persistentLoginProfileDir } from './login-cdp.ts'
export type { LoginOptions } from './login-cdp.ts'
export type {
  WorkbenchLoginResult, WorkbenchProject, WorkbenchStatus, WorkbenchWireResponse,
} from './types.ts'
