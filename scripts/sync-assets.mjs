import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const projectDir = path.resolve(scriptDir, '..')
const vaultPath = process.env.VAULT_PATH
  ? path.resolve(process.env.VAULT_PATH)
  : path.resolve(projectDir, '../../..')
const pluginOutDir = path.join(vaultPath, '.obsidian/plugins/project-manager-fork')

if (!existsSync(path.join(vaultPath, '.obsidian'))) {
  process.exit(0)
}

mkdirSync(pluginOutDir, { recursive: true })

for (const filename of ['manifest.json', 'styles.css']) {
  copyFileSync(path.join(projectDir, filename), path.join(pluginOutDir, filename))
}
