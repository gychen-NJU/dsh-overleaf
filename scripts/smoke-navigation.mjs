import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  WORKBENCH_HOME, WORKBENCH_SETTINGS_CHANGED, workbenchEntry,
  navigateToWorkbenchHome, updateFrameUpstream,
} from '../lib/types/client/navigation.js'
import { cookieDomainMatchesHost } from '../lib/types/login-cdp.js'

assert.equal(WORKBENCH_HOME, '/overleaf-proxy/')
assert.equal(workbenchEntry(), WORKBENCH_HOME)
assert.equal(workbenchEntry('/overleaf-proxy/'), WORKBENCH_HOME)
assert.equal(workbenchEntry('https://example.test/project'), WORKBENCH_HOME)
assert.equal(workbenchEntry('//example.test/project'), WORKBENCH_HOME)
assert.equal(workbenchEntry('/overleaf-proxy/../outside'), WORKBENCH_HOME)
assert.equal(workbenchEntry('/overleaf-proxy/%2e%2e/outside'), WORKBENCH_HOME)

const frame = { src: WORKBENCH_HOME, dataset: {} }
assert.equal(updateFrameUpstream(frame, 'https://www.overleaf.com'), false)
frame.src = '/overleaf-proxy/project/current-project'
assert.equal(updateFrameUpstream(frame, 'https://www.overleaf.com'), false)
assert.equal(frame.src, '/overleaf-proxy/project/current-project', 'tab remount keeps current project')
assert.equal(updateFrameUpstream(frame, 'https://tex.nju.edu.cn'), true)
assert.equal(frame.src, WORKBENCH_HOME, 'base URL switch leaves the obsolete /project route')
frame.src = '/overleaf-proxy/login'
navigateToWorkbenchHome(frame)
assert.equal(frame.src, WORKBENCH_HOME, 'verified login reloads the neutral home')
navigateToWorkbenchHome(null)

assert.equal(cookieDomainMatchesHost('tex.nju.edu.cn', 'tex.nju.edu.cn'), true)
assert.equal(cookieDomainMatchesHost('.nju.edu.cn', 'tex.nju.edu.cn'), true)
assert.equal(cookieDomainMatchesHost('.overleaf.com', 'www.overleaf.com'), true)
assert.equal(cookieDomainMatchesHost('www.overleaf.com', 'www.overleaf.com'), true)
assert.equal(cookieDomainMatchesHost('overleaf.com', 'www.overleaf.com'), false, 'host-only scope is not inherited')
assert.equal(cookieDomainMatchesHost('sub.tex.nju.edu.cn', 'tex.nju.edu.cn'), false)
assert.equal(cookieDomainMatchesHost('.tex.nju.edu.cn.evil.test', 'tex.nju.edu.cn'), false)
assert.equal(cookieDomainMatchesHost('.overleaf.com', 'tex.nju.edu.cn'), false)

const view = await readFile(new URL('../src/client/view.tsx', import.meta.url), 'utf8')
const settings = await readFile(new URL('../src/client/settings-card.tsx', import.meta.url), 'utf8')
assert.ok(view.includes('frame.src = WORKBENCH_HOME'))
assert.ok(view.includes('const embedEntry = workbenchEntry(embedInfo?.embedUrl)'))
assert.ok(!view.includes("'/overleaf-proxy/project'"), 'no hardcoded standard-Overleaf entry')
assert.equal((view.match(/navigateToWorkbenchHome\(frameRef\.current\)/g) ?? []).length, 2, 'automatic and manual login both reload')
assert.ok(WORKBENCH_SETTINGS_CHANGED.startsWith('dsh-overleaf:'))
assert.ok(settings.includes('window.dispatchEvent(new Event(WORKBENCH_SETTINGS_CHANGED))'))
assert.ok(view.includes('window.addEventListener(WORKBENCH_SETTINGS_CHANGED, refresh)'))
console.log('navigation smoke passed: neutral entry, upstream changes, login refresh, cookie domain scope')
