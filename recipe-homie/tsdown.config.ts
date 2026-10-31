import { defineConfig } from 'tsdown'

// Same two-target split as dsh-reme-lite: Node ESM entries under lib/ (with
// every `@deepseek-ai/*` host package left external — in practice only the
// optional dynamic schemastery import exists), and the browser client as one
// classic script wrapped in the host's `window.__ModuleLoader__.load` contract.
export default defineConfig([
  {
    entry: {
      index: 'src/index.ts',
      query: 'src/query.ts',
      parse: 'src/parse.ts',
    },
    outDir: 'lib',
    format: 'esm',
    fixedExtension: false,
    platform: 'node',
    target: 'es2024',
    dts: true,
    clean: true,
    deps: { neverBundle: [/^@deepseek-ai\//] },
  },
  {
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    clean: false,
    deps: { neverBundle: ['react', 'react/jsx-runtime', 'react-dom'] },
    outputOptions: {
      entryFileNames: 'client.js',
      banner:
        'window.__ModuleLoader__.load({ id: "dsh-recipe-homie", factory: (require) => {',
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
