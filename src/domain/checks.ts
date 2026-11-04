import type { Bug, RequirementId } from './bug.ts'

export interface FieldCheck {
  id: RequirementId
  passed: boolean
  detail: string
}

// Section keys accepted in the description, by requirement. Matched inline ("Steps to reproduce:")
// or as a heading on its own line ("h3. Steps", "*Expected*"). Abbreviations of up to three
// letters count only at the start of a line: "Set AR: 10" is prose, "AR: nothing happens" a key.
const STEPS = ['steps to reproduce', 'steps to reproduce the issue', 'reproduction steps', 'how to reproduce', 'steps', 'str']
const EXPECTED = ['expected result', 'expected results', 'expected behaviou?r', 'expected', 'er']
const ACTUAL = ['actual result', 'actual results', 'actual behaviou?r', 'actual', 'ar']

// Words that name a KAZ device in free text: board types and chip families (jira-reference.md).
// Product names are not matched: Cuba, India and Napoli are also places.
const DEVICE_WORDS = [
  'NPB-II',
  'NPB-IIe',
  'NPB-III',
  'NPB-IV',
  'NPB-Ie',
  'NPB-Ie6',
  'NPB-Ie6-XL',
  'NPB-Ie8',
  'NPB-IOT',
  'NPB-All',
  'Trident 3',
  'Trident3',
  'Tomahawk 3',
  'Tomahawk3',
  'Tomahawk 1',
  'Tomahawk',
  'Jericho 2',
  'Jericho 1',
  'Jericho',
  'Qumran',
]

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function hasSection(text: string, names: string[]): boolean {
  const words = names.filter((n) => n.length > 3)
  const short = names.filter((n) => n.length <= 3)
  const alt = names.join('|')
  const inline = words.length > 0 && new RegExp(`(?:^|[^\\w-])(?:${words.join('|')})\\s*[:：]`, 'i').test(text)
  const inlineShort = short.length > 0 && new RegExp(`^[\\s*_]*(?:${short.join('|')})\\s*[:：]`, 'im').test(text)
  const heading = new RegExp(`^[\\s*_#+\\-]*(?:h[1-6]\\.)?[\\s*_]*(?:${alt})[\\s*_:]*$`, 'im').test(text)
  return inline || inlineShort || heading
}

const deviceWordsRe = new RegExp(`(?:^|[^\\w-])(?:${DEVICE_WORDS.map(escape).join('|')})(?![\\w-])`, 'i')

function sectionCheck(id: RequirementId, text: string, names: string[], label: string): FieldCheck {
  const passed = hasSection(text, names)
  return { id, passed, detail: passed ? `"${label}" heading present` : `no "${label}" heading` }
}

export function checkFields(bug: Bug): FieldCheck[] {
  const text = bug.description
  const har = bug.attachments.filter((a) => a.filename.toLowerCase().endsWith('.har'))
  return [
    sectionCheck('R1', text, STEPS, 'Steps to reproduce'),
    sectionCheck('R2', text, EXPECTED, 'Expected result'),
    sectionCheck('R3', text, ACTUAL, 'Actual result'),
    {
      id: 'R4',
      passed: bug.versions.length > 0,
      detail: bug.versions.length > 0 ? `Affects versions: ${bug.versions.join(', ')}` : 'Affects versions is empty',
    },
    deviceCheck(bug),
    {
      id: 'R6',
      passed: har.length > 0,
      detail: har.length > 0 ? `HAR attached: ${har.map((a) => a.filename).join(', ')}` : 'no .har attachment',
    },
  ]
}

function deviceCheck(bug: Bug): FieldCheck {
  if (bug.project === 'RPG') {
    const passed = bug.devices.includes('AFS')
    return { id: 'R5', passed, detail: passed ? 'Devices: AFS' : 'Devices field does not name AFS' }
  }
  if (bug.devices.length > 0) return { id: 'R5', passed: true, detail: `Devices: ${bug.devices.join(', ')}` }
  const inText = deviceWordsRe.exec(`${bug.summary}\n${bug.description}`)
  if (inText) return { id: 'R5', passed: true, detail: `device named in text: ${inText[0].trim()}` }
  return { id: 'R5', passed: false, detail: 'Devices field is empty and no board type or chip is named in the text' }
}
