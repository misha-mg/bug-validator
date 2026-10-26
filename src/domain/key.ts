/** The issues the service may touch: KAZ and RPG, as the agent's tool and the UI's routes agree. */
export const ISSUE_KEY = /^(KAZ|RPG)-\d+$/;

/**
 * The key in what a person typed or pasted: "kaz-9043", a browse link, a board link with
 * `selectedIssue=`; null when there is none.
 */
export function issueKey(text: string): string | null {
  const found = /(?:^|[/=\s])(KAZ|RPG)-(\d+)(?=$|[^\w-])/i.exec(text.trim());
  return found ? `${found[1]!.toUpperCase()}-${found[2]}` : null;
}
