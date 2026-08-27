/**
 * Overleaf workbench credential references. Values never pass through plugin
 * config or route responses; the host resolves and stores them through
 * `ctx.credentials`. The ref name is deliberately namespaced away from
 * dsh-better-overleaf's OVERLEAF_COOKIE so two Overleaf plugins never fight
 * over one stored value.
 */
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'

/**
 * Session cookies captured by the direct-CDP login (also accepted from the
 * manual-cookie route). Stored as one `Cookie:` header string
 * (`name=value; name2=value2`) scoped to the configured baseUrl.
 */
export const OVERLEAF_WORKBENCH_COOKIE: CredentialRef = credentialRef('OVERLEAF_WORKBENCH_COOKIE')
