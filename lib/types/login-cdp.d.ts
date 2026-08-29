import type { CredentialProvider } from '@deepseek-ai/dsh-credentials';
import type { WorkbenchLoginResult } from './types.ts';
import type { LoginProfileMode, OverleafBrowserChannel } from './config.ts';
/** Stable dedicated profile directory for persistent login sessions. */
export declare function persistentLoginProfileDir(): string;
/** Login orchestration options resolved from plugin config. */
export interface LoginOptions {
    /** Absolute login page URL of the upstream origin. */
    loginUrl: string;
    /** Origin whose cookies belong to this account (host suffix match). */
    targetHost: string;
    /** Upstream origin (used for generic landing-page and validation checks). */
    baseUrl: string;
    /** Project URL prefix proving the browser login reached a real session. */
    projectUrlPrefix: string;
    browserChannel: OverleafBrowserChannel;
    /** Explicit Chromium-family executable tried first when set. */
    browserPath?: string;
    /** Chromium --proxy-server value for the login window (Google reCAPTCHA access); empty = system. */
    loginProxyServer?: string;
    timeoutMs: number;
    profileMode?: LoginProfileMode | undefined;
}
/**
 * Run the CDP login flow. Returns automatic when cookies were captured,
 * otherwise opens the default browser and returns manual-paste instructions.
 * @param credentials - host credential service.
 * @param options - login orchestration options.
 */
export declare function loginViaCdp(credentials: Pick<CredentialProvider, 'set'>, options: LoginOptions): Promise<WorkbenchLoginResult>;
