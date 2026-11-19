import { LinkifyIt } from 'linkify-it';
import { hashtagMatches } from './model.js';

const parser = new LinkifyIt()
  .set({ fuzzyLink: true, fuzzyEmail: false, fuzzyIP: false })
  .add('ftp:', null)
  .add('mailto:', null)
  .add('//', null);

// Return text segments, never HTML. Rendering escapes both labels and hrefs.
export function parseTextLinks(text) {
  const parts = [];
  let cursor = 0;
  for (const match of parser.match(text) ?? []) {
    let url;
    try {
      url = new URL(match.url);
    } catch {
      continue;
    }
    if (!['http:', 'https:'].includes(url.protocol)) continue;
    if (match.index > cursor) parts.push({ text: text.slice(cursor, match.index), url: null });
    parts.push({ text: text.slice(match.index, match.lastIndex), url: url.href });
    cursor = match.lastIndex;
  }
  if (cursor < text.length || !parts.length) parts.push({ text: text.slice(cursor), url: null });
  return parts;
}

export function parseViewerText(text, linkUrls) {
  const tags = [...hashtagMatches(text)];
  if (!tags.length) return linkUrls ? parseTextLinks(text) : [{ text }];
  const links = [];
  let offset = 0;
  for (const part of parseTextLinks(text)) {
    const end = offset + part.text.length;
    if (part.url) links.push({ start: offset, end, url: part.url });
    offset = end;
  }
  for (const match of tags) {
    links.push({ start: match.index, end: match.index + match[0].length, tag: match[1].toLowerCase() });
  }
  // A URL consumes its fragment. A hashtag starting before a fuzzy URL takes precedence.
  links.sort((a, b) => a.start - b.start);
  const parts = [];
  let consumed = 0;
  let cursor = 0;
  for (const { start, end, ...link } of links) {
    if (start < consumed) continue;
    consumed = end;
    if (link.url && !linkUrls) continue;
    if (start > cursor) parts.push({ text: text.slice(cursor, start) });
    parts.push({ text: text.slice(start, end), ...link });
    cursor = end;
  }
  if (cursor < text.length || !parts.length) parts.push({ text: text.slice(cursor) });
  return parts;
}

export function hasOnlyLinks(text) {
  if (typeof text !== 'string' || !text.trim()) return false;
  const parts = parseTextLinks(text);
  return parts.some(part => part.url !== null) && parts.every(part => part.url !== null || !part.text.trim());
}
