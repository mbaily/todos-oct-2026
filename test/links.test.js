import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTextLinks, parseViewerText } from '../src/lib/links.js';

function links(text) {
  const parts = parseTextLinks(text);
  assert.equal(parts.map(part => part.text).join(''), text);
  return parts.filter(part => part.url);
}

test('URL parsing preserves empty and plain text without producing HTML', () => {
  for (const text of ['', 'A plain note\nwith #tags', '<img src=x onerror=alert(1)>']) {
    assert.deepEqual(parseTextLinks(text), [{ text, url: null }]);
  }
});

test('URL parsing recognizes HTTP, HTTPS, www addresses and bare domains', () => {
  const text = 'Read https://example.com/a?x=1&y=2, http://example.org/notes and www.example.net/docs. Also example.edu.';
  assert.deepEqual(links(text).map(part => part.url), [
    'https://example.com/a?x=1&y=2',
    'http://example.org/notes',
    'http://www.example.net/docs',
    'http://example.edu/',
  ]);
});

test('URL parsing excludes sentence punctuation and preserves balanced path parentheses', () => {
  const text = 'See (https://example.com/wiki/Function_(math)), then "https://example.org/next".';
  assert.deepEqual(links(text).map(part => part.text), [
    'https://example.com/wiki/Function_(math)',
    'https://example.org/next',
  ]);
});

test('URL parsing preserves Unicode labels and normalizes safe URL destinations', () => {
  const url = 'https://例え.テスト/道#項目';
  assert.deepEqual(links(`📝 日本語 ${url} ✅`), [{ text: url, url: new URL(url).href }]);
});

test('unsafe schemes, email addresses and unsupported protocols are not linked', () => {
  const text = 'javascript:alert(1) data:text/html,<script>alert(1)</script> mailto:user@example.com ftp://example.com/file user@example.com';
  assert.deepEqual(links(text), []);
});

test('malformed destinations remain plain text while later valid links still work', () => {
  const text = 'https://example.com:99999/path then https://example.org/valid';
  assert.deepEqual(links(text), [{ text: 'https://example.org/valid', url: 'https://example.org/valid' }]);
});

test('viewer links use the same hashtag rules as search and preserve URL fragments', () => {
  const url = 'https://example.com/#anchor';
  const text = `word#plain (#İstanbul #日本語_2-tag), ${url} #example.com`;
  const parts = parseViewerText(text, true);
  assert.equal(parts.map(part => part.text).join(''), text);
  assert.deepEqual(parts.filter(part => part.tag || part.url), [
    { text: '#İstanbul', tag: 'i̇stanbul' },
    { text: '#日本語_2-tag', tag: '日本語_2-tag' },
    { text: url, url },
    { text: '#example', tag: 'example' },
  ]);
  const nameParts = parseViewerText(text, false);
  assert.equal(nameParts.map(part => part.text).join(''), text);
  assert.deepEqual(nameParts.filter(part => part.tag || part.url), parts.filter(part => part.tag));
});

test('hasOnlyLinks identifies text containing only links and whitespace', async () => {
  const { hasOnlyLinks } = await import('../src/lib/links.js');
  assert.equal(hasOnlyLinks('https://example.com'), true);
  assert.equal(hasOnlyLinks('  https://example.com  '), true);
  assert.equal(hasOnlyLinks('https://a.com https://b.com'), true);
  assert.equal(hasOnlyLinks('www.example.org'), true);
  assert.equal(hasOnlyLinks('Text https://example.com'), false);
  assert.equal(hasOnlyLinks('https://example.com and text'), false);
  assert.equal(hasOnlyLinks('Just text'), false);
  assert.equal(hasOnlyLinks(''), false);
  assert.equal(hasOnlyLinks('   '), false);
});
