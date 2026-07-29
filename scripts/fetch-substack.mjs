// Rebuilds blog/posts.json from the Substack RSS feed.
// Node 20+, zero dependencies (global fetch, AbortSignal.timeout).
// Run by .github/workflows/substack-sync.yml, or by hand: node scripts/fetch-substack.mjs

import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const FEED = 'https://jamesfbaker.substack.com/feed';
const OUT = fileURLToPath(new URL('../blog/posts.json', import.meta.url));
const AGENT = 'deskofjim-substack-sync (+https://deskofjim.com)';

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

const decode = (s) =>
  s.replace(/&(#\d+|#x[\da-f]+|[a-z]+);/gi, (raw, ref) => {
    if (ref[0] !== '#') return NAMED[ref.toLowerCase()] ?? raw;
    const code = ref[1].toLowerCase() === 'x' ? parseInt(ref.slice(2), 16) : Number(ref.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : raw;
  });

// CDATA content is literal by definition, so entities inside it must not be decoded here.
const field = (item, name) => {
  const m = item.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  if (!m) return '';
  const cdata = m[1].match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return (cdata ? cdata[1] : decode(m[1])).trim();
};

// Descriptions arrive as HTML inside the XML, so entities get a second (HTML-level) pass.
const plain = (html) => decode(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

const cap = (s, n = 300) => {
  if (s.length <= n) return s;
  const space = s.lastIndexOf(' ', n);
  return s.slice(0, space > n / 2 ? space : n).trimEnd() + '…';
};

// The feed mixes straight and curly apostrophes across posts; a serif page telegraphs the mix.
const curl = (s) => s.replace(/'/g, '’');

async function main() {
  const res = await fetch(FEED, { headers: { 'user-agent': AGENT }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`feed returned HTTP ${res.status}`);
  const items = (await res.text()).match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/g) ?? [];
  if (!items.length) throw new Error('feed contained no items');

  const fresh = items.map((item) => {
    const title = curl(field(item, 'title'));
    const url = field(item, 'link').replace(/[?#].*$/, '');
    const pubDate = field(item, 'pubDate');
    const ms = Date.parse(pubDate);
    if (!title || !url || Number.isNaN(ms)) throw new Error(`malformed item: ${title || url || pubDate || '(empty)'}`);
    const subtitle = cap(curl(plain(field(item, 'description'))));
    const post = { title, url, date: new Date(ms).toISOString().slice(0, 10) };
    if (subtitle) post.subtitle = subtitle; // never clobber a good subtitle with an empty one
    return post;
  });

  // The feed only carries the recent ~20 posts; older ones live on in the file.
  const before = await readFile(OUT, 'utf8').catch(() => '');
  const previous = before ? JSON.parse(before) : {};
  const byUrl = new Map((previous.posts ?? []).map((p) => [p.url, p]));
  let added = 0;
  for (const post of fresh) {
    if (!byUrl.has(post.url)) added++;
    byUrl.set(post.url, { ...byUrl.get(post.url), ...post });
  }
  const posts = [...byUrl.values()].sort((a, b) => b.date.localeCompare(a.date) || a.url.localeCompare(b.url));

  const stale = JSON.stringify(posts) !== JSON.stringify(previous.posts ?? []);
  const generated = stale || !previous.generated ? new Date().toISOString().replace(/\.\d+Z$/, 'Z') : previous.generated;
  const out = JSON.stringify({ source: FEED, generated, posts }, null, 2) + '\n';
  if (out === before) {
    console.log(`substack: ${posts.length} posts, unchanged`);
    return;
  }

  // Write to a sibling then rename: a crashed run must never leave a half-written posts.json.
  const tmp = `${OUT}.tmp`;
  try {
    await writeFile(tmp, out);
    await rename(tmp, OUT);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
  console.log(`substack: ${posts.length} posts (${added} new, ${items.length} in feed) → blog/posts.json`);
}

main().catch((err) => {
  console.error(`substack sync failed: ${err.message}`);
  process.exit(1);
});
