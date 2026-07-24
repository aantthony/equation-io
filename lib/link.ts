/**
 * Graph-link payload codec, shared by the web app and the worker.
 *
 * A payload is the part after `/#` or `/g/`: percent-encoded equations joined
 * by `;`. Beyond encodeURIComponent we also escape ( ) ! ' * — chat-app URL
 * linkifiers (iMessage, Slack, Markdown) cut links at those characters, and a
 * truncated payload renders the wrong graph.
 */

import { splitStatements } from './statements.ts';

const LINK_UNSAFE = /[()!'*]/g;

const encodeRow = (text: string): string =>
  encodeURIComponent(text).replace(LINK_UNSAFE, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

export function encodePayload(texts: string[]): string {
  return texts.filter(t => t.trim()).map(t => encodeRow(t.trim())).join(';');
}

/**
 * Rows from a payload, reading both the `/g/` form and legacy `/#…` links.
 *
 * The separator survives in either spelling. We emit a literal `;`, but a
 * round trip through the address bar, a copy, or a chat client can hand it
 * back as `%3B`, and a payload that no longer separates renders as one row
 * containing a `;` — which then fails to parse. Equations never contain a bare
 * `;` (it is only the row separator, as llms.txt states), so normalizing the
 * encoded form is unambiguous.
 *
 * Rows are then decoded exactly once. Decoding the whole payload up front
 * instead would also un-escape any other `%`-sequence before the split, so a
 * row is decoded here and never again.
 */
export function decodePayload(payload: string): string[] {
  return splitStatements(payload.replace(/%3B/gi, ';'))
    .map(s => decodeURIComponent(s))
    .filter(s => s.trim());
}
