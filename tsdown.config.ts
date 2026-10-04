import type { UserConfig } from 'tsdown'

const PLUGIN_ID = '@bananiceee/dsh-chatgpt-provider'

/**
 * Packages the host already provides to the page. They must stay external: the
 * client module system resolves them through its own `require`, and bundling a
 * second copy would break the slot registry identity (two `slots` instances)
 * and duplicate React.
 */
const CLIENT_EXTERNALS = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  'cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-runtime/client',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-locale/client',
  '@deepseek-ai/dsh-client-ui-settings/client',
]

/**
 * The browser half as the loader expects it: one lazy-CJS factory registered
 * on `window.__ModuleLoader__`. The client module system serves this file and
 * evaluates it in the page, so the wrapper must be the bundle's own banner —
 * an ESM artifact would not load at all.
 */
const clientBundle: UserConfig = {
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  deps: {
    neverBundle: [...CLIENT_EXTERNALS],
    alwaysBundle: (id: string) => !CLIENT_EXTERNALS.includes(id),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: ' + JSON.stringify(PLUGIN_ID) + ', factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    codeSplitting: false,
  },
}

export default [clientBundle] satisfies UserConfig[]
