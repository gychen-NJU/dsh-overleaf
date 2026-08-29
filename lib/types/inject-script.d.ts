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
export declare const BRIDGE_SCRIPT_NAME = "bridge.js";
export declare function renderBridgeScript(): string;
