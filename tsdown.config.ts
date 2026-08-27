/**
 * Build dsh-overleaf as a dual-face DSH plugin:
 * - host pass: ESM `lib/index.js` loaded by the dsh web host;
 * - client pass: CJS `lib/client.js` closure registered through
 *   `window.__ModuleLoader__.load({ id, factory })`.
 *
 * The client module id must equal the npm package name: dsh-client-modules
 * matches each `/plugins/<pkg>/client.js` bundle against a registration under
 * `<pkg>` (any other id triggers "loaded without registering"). `dsh-overleaf`
 * is free — dsh-better-overleaf now registers under its own package name.
 */
import { defineConfig } from 'tsdown'

const ID = 'dsh-overleaf'

const CLIENT_EXTERNALS = ['react', 'react/jsx-runtime'] as const

const CLIENT_DEFINES = {
  'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
}

export default defineConfig([
  {
    name: ID,
    entry: ['lib/types/index.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    fixedExtension: false,
    target: 'es2024',
    dts: false,
    clean: false,
  },
  {
    name: `${ID}/client`,
    entry: { client: 'lib/types/client/index.js' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2024',
    dts: false,
    sourcemap: true,
    clean: false,
    external: [...CLIENT_EXTERNALS],
    define: CLIENT_DEFINES,
    noExternal: id => !CLIENT_EXTERNALS.includes(id as (typeof CLIENT_EXTERNALS)[number]),
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
