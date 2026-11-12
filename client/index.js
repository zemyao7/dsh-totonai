import { readFileSync } from 'node:fs'

export const name = 'totonai-academic-skills'
export const inject = ['skills']

const SKILL_FILES = [
  'literature-card',
  'citation-format',
  'journal-polish',
  'review-outline',
]

/** Split YAML frontmatter from the Markdown body. */
function parse(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!match) return { meta: {}, body: text }
  const meta = {}
  for (const line of match[1].split(/\r?\n/)) {
    const at = line.indexOf(':')
    if (at <= 0) continue
    const key = line.slice(0, at).trim()
    const value = line.slice(at + 1).trim().replace(/^["']|["']$/g, '')
    if (key) meta[key] = value
  }
  return { meta, body: text.slice(match[0].length) }
}

export function apply(ctx) {
  for (const file of SKILL_FILES) {
    const text = readFileSync(new URL(`./skills/${file}.md`, import.meta.url), 'utf8')
    const { meta, body } = parse(text)
    const skill = {
      name: meta.name || file,
      description: meta.description || file,
      source: 'custom',
      content: body,
    }
    if (meta.whenToUse) skill.whenToUse = meta.whenToUse
    ctx.effect(() => ctx.skills.register(skill))
  }
}
