// Copies the coding-agent contract into public/ so the deployed site serves it
// verbatim at /agent-instructions.md (and /llms.txt, the discoverable convention).
// Runs automatically before `npm run dev` and `npm run build`.
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'docs', 'code-apps', 'AGENT-INSTRUCTIONS.md')
mkdirSync(join(root, 'public'), { recursive: true })
for (const name of ['agent-instructions.md', 'llms.txt']) {
  copyFileSync(source, join(root, 'public', name))
}
