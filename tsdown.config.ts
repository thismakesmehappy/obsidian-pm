import { existsSync } from 'node:fs'
import path from 'node:path'
import { builtinModules } from 'node:module'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'tsdown'

const prod = Boolean(process.env['PRODUCTION'])
const vaultPath = process.env['VAULT_PATH']
const projectDir = path.dirname(fileURLToPath(import.meta.url))
const localVaultPath = path.resolve(projectDir, '../../..')
const localPluginOutDir = path.join(localVaultPath, '.obsidian/plugins/project-manager-fork')
const outDir = vaultPath
  ? path.join(vaultPath, '.obsidian/plugins/project-manager-fork')
  : existsSync(path.join(localVaultPath, '.obsidian'))
    ? localPluginOutDir
    : '.'

export default defineConfig({
  entry: 'src/main.ts',
  format: 'cjs',
  target: 'es2022',
  outDir,
  platform: 'node',
  dts: false,
  minify: prod,
  sourcemap: prod ? false : 'inline',
  clean: false,
  hash: false,
  outExtensions: () => ({ js: '.js' }),
  deps: {
    neverBundle: [
      'obsidian',
      'electron',
      '@codemirror/autocomplete',
      '@codemirror/collab',
      '@codemirror/commands',
      '@codemirror/language',
      '@codemirror/lint',
      '@codemirror/search',
      '@codemirror/state',
      '@codemirror/view',
      '@lezer/common',
      '@lezer/highlight',
      '@lezer/lr',
      ...builtinModules
    ]
  }
})
