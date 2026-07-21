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
 * Split first, then decode each row exactly once. Decoding the whole payload
 * up front would turn an encoded `%3B` inside an equation into a real `;` and
 * split there, tearing the equation in half. Splitting stays bracket-aware so
 * a literal `;` inside brackets — reachable in a hand-written link — does not
 * start a new row either, matching the editor's paste rule.
 */
export function decodePayload(payload: string): string[] {
  return splitStatements(payload)
    .map(s => decodeURIComponent(s))
    .filter(s => s.trim());
}
