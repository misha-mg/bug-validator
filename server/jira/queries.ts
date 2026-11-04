/** The trigger (prd.md, Trigger): new WebUI bugs in KAZ and RPG, whoever reported them. */
export const TRIGGER_JQL =
  'type = Bug AND status = Created AND labels IN (WebUI, Web_UI_2.0) AND project IN (Arpeggio, Kazaar) ORDER BY created ASC'

/**
 * The agent's JQL narrowed to KAZ and RPG before Jira counts the results, so other projects do
 * not take up the slots; its ORDER BY stays at the end.
 */
export function scopedJql(jql: string): string {
  const order = /(?:^|\s+)ORDER\s+BY\s+/i.exec(jql)
  const where = (order ? jql.slice(0, order.index) : jql).trim()
  const orderBy = order ? jql.slice(order.index).trim() : ''
  return [`project IN (KAZ, RPG)${where ? ` AND (${where})` : ''}`, orderBy].filter(Boolean).join(' ')
}
