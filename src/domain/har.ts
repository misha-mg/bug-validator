/**
 * A HAR file as the agent may read it. A HAR holds the session: cookies, the Authorization
 * header, tokens in URLs and bodies. The service's own Jira token could not be in one, but the
 * reporter's WebUI session is, and the agent must not see a secret it could repeat in a comment.
 */

/** A header, parameter or JSON field with such a name loses its value. */
const SECRET_NAME = /cookie|authorization|token|secret|password|passwd|session|auth|api[-_]?key|credential/i;
/** Response bodies that are not text are of no use to the agent and make the file huge. */
const BINARY_MIME = /^(image|font|audio|video)\/|octet-stream|zip|pdf|wasm/i;
/** A text body is cut here: a long one is a bundle or a data dump, not what the bug is about. */
export const MAX_BODY_CHARS = 64 * 1024;
const REMOVED = '[removed]';

/** The HAR text with every secret-looking value removed and bodies made small. Throws when it is not a HAR. */
export function cleanHar(text: string): string {
  const har: unknown = JSON.parse(text);
  if (!isObject(har) || !isObject(har.log) || !Array.isArray(har.log.entries)) throw new Error('not a HAR: no log.entries');
  return JSON.stringify(clean(har, ''), null, 1);
}

function clean(value: unknown, key: string): unknown {
  if (Array.isArray(value)) {
    // A `cookies` list goes whole, not one value at a time.
    if (key === 'cookies') return [];
    return value.map((v) => clean(v, ''));
  }
  if (!isObject(value)) return typeof value === 'string' && SECRET_NAME.test(key) ? REMOVED : value;
  // A {name, value} pair (headers, queryString, params): the value goes by the name.
  if (typeof value.name === 'string' && 'value' in value && SECRET_NAME.test(value.name)) return { ...value, value: REMOVED };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === 'url' && typeof v === 'string') out[k] = cleanUrl(v);
    else if (k === 'text' && typeof v === 'string') out[k] = cleanBody(v, typeof value.mimeType === 'string' ? value.mimeType : '', value.encoding === 'base64');
    else out[k] = clean(v, k);
  }
  return out;
}

/** The query values of secret-looking parameters removed; a URL that does not parse is left as it is. */
function cleanUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  let changed = false;
  for (const name of [...parsed.searchParams.keys()]) {
    if (SECRET_NAME.test(name)) {
      parsed.searchParams.set(name, REMOVED);
      changed = true;
    }
  }
  return changed ? parsed.toString() : url;
}

/** A body: dropped when binary, cleaned as JSON when it is JSON, else cut and scrubbed by pattern. */
function cleanBody(text: string, mimeType: string, base64: boolean): string {
  if (base64 || BINARY_MIME.test(mimeType)) return `[${text.length} characters of ${mimeType || 'binary'} removed]`;
  let body = text;
  try {
    body = JSON.stringify(clean(JSON.parse(text), ''));
  } catch {
    // Not JSON (a form, HTML, a script): a "name=value" or "name: value" with a secret-looking name.
    body = text.replace(/((?:^|[?&;,\s{"'])(?:[\w.-]*(?:token|secret|password|passwd|session|auth|cookie|api[-_]?key|credential)[\w.-]*)["']?\s*[:=]\s*["']?)[^"'&;,\s}]+/gi, `$1${REMOVED}`);
  }
  return body.length > MAX_BODY_CHARS ? `${body.slice(0, MAX_BODY_CHARS)}\n[… ${body.length - MAX_BODY_CHARS} more characters cut]` : body;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
