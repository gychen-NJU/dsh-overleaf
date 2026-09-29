/**
 * Minimal Electron application entry for the dsh-overleaf desktop-shell harness.
 *
 * Why this wrapper exists (each point verified empirically):
 *   1. A PACKAGED Electron binary (including the DeepSeek Harness desktop exe)
 *      ignores an external script-path argument — it always runs its own
 *      app.asar, so `"...DeepSeek Harness.exe" harness.mjs` never executes the
 *      harness (it exits 0 after the single-instance hand-off, which is easy to
 *      mistake for success). A stock Electron build is therefore required.
 *   2. The stock Electron default app cannot load an ESM file (`require()` of an
 *      `.mjs` throws), so the harness needs this app-directory shape.
 *   3. The harness must run BEFORE `ready`: it registers the `dsh-app` protocol
 *      privileges and points `userData` at a throwaway profile, both of which
 *      Electron only honours before the app is ready. Waiting for `ready` here
 *      and importing afterwards failed with "protocol.registerSchemesAsPrivileged
 *      should be called before app is ready". So this entry registers the scheme,
 *      imports the harness immediately, and only then lets the harness await ready
 *      (with its own 30 s watchdog that writes a failing report instead of
 *      hanging).
 *
 * Usage (see scripts/desktop-shell-harness.mjs for flags, assertions and the
 * JSON report contract):
 *   scripts\desktop-shell-harness.cmd [flags]        <- preferred (finds Electron,
 *                                                       clears ELECTRON_RUN_AS_NODE)
 *   "<stock electron.exe>" scripts/desktop-shell [flags]
 *
 * Exit code: the harness verdict (0 pass, 1 assertion failed, 2 precondition,
 * 3 internal); it is propagated even if the module never loads.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

let electron = null
try {
  electron = require('electron')
} catch (err) {
  process.stderr.write(`[harness] electron runtime unavailable: ${err.message}\n`)
  process.exit(2)
}
const { app, protocol } = electron
if (!app || !protocol) {
  process.stderr.write('[harness] electron runtime unavailable: no app/protocol module\n')
  process.exit(2)
}

// Same privileges the desktop shell declares for dsh-app; must be registered
// before the app becomes ready.
try {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'dsh-app',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ])
  process.env.DSH_HARNESS_SCHEME_REGISTERED = '1'
} catch (err) {
  process.stderr.write(`[harness] dsh-app scheme registration failed: ${err.message}\n`)
}

// Known Electron pitfall: a packaged build must not claim the running app's
// single-instance lock, so nothing here calls requestSingleInstanceLock().
const harnessPath = path.join(__dirname, '..', 'desktop-shell-harness.mjs')

function reportLoadFailure(detail) {
  const line = `${new Date().toISOString()} ${detail}\n`
  process.stderr.write(`[harness] could not load ${harnessPath}: ${detail}\n`)
  try {
    fs.appendFileSync(path.join(os.tmpdir(), 'dsh-overleaf-shell-harness-load-error.txt'), line)
  } catch {
    /* best effort */
  }
}

// A Windows absolute path is not importable: it must be a file:// URL.
import(pathToFileURL(harnessPath).href).catch((err) => {
  reportLoadFailure(err && err.stack ? err.stack : String(err))
  app.exit(3)
})

// Never hang silently: the harness normally owns the exit code; if the app never
// becomes ready nothing will ever report, so fail loudly here.
setTimeout(() => {
  reportLoadFailure('app.whenReady() did not settle within 120s')
  app.exit(2)
}, 120000).unref?.()
