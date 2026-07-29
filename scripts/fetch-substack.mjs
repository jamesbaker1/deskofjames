// Rebuilds blog/posts.json from the Substack RSS feed.
// Node 20+, zero dependencies (global fetch, AbortSignal.timeout).
// Run by .github/workflows/substack-sync.yml, or by hand: node scripts/fetch-substack.mjs

import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const SITE = 'https://jamesfbaker.substack.com';
const FEED = `${SITE}/feed`;
const OUT = fileURLToPath(new URL('../blog/posts.json', import.meta.url));
// Substack's CDN 403s obvious-bot user agents from datacenter IPs (GitHub runners included),
// so this asks the way a browser would.
const HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  accept: 'application/rss+xml, application/xml, text/xml, application/json;q=0.9, */*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function attempt(url) {
  for (let tries = 0, waits = [5_000, 20_000]; ; tries++) {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20_000) }).catch((err) => {
      if (tries >= waits.length) throw err;
      return null;
    });
    if (res?.ok) return res;
    if (tries >= waits.length) throw new Error(`${url.replace(SITE, '')} returned HTTP ${res?.status ?? 'no response'}`);
    await sleep(waits[tries]);
  }
}

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

async function fromFeed() {
  // CI fetches the feed with curl first (Cloudflare tolerates its TLS fingerprint better than
  // undici's) and hands the file over via FEED_FILE; everywhere else this fetches directly.
  const xml = process.env.FEED_FILE
    ? await readFile(process.env.FEED_FILE, 'utf8')
    : await (await attempt(FEED)).text();
  const items = xml.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/g) ?? [];
  if (!items.length) throw new Error('feed contained no items');

  return items.map((item) => {
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
}

// Same posts, Substack's JSON API — a second door for when the CDN dislikes the first.
async function fromApi() {
  const res = await attempt(`${SITE}/api/v1/posts?limit=50`);
  const rows = await res.json();
  if (!Array.isArray(rows) || !rows.length) throw new Error('api returned no posts');

  return rows
    .filter((r) => r.post_date && r.canonical_url && (r.audience ?? 'everyone') !== 'only_paid')
    .map((r) => {
      const post = {
        title: curl(decode(String(r.title ?? '')).trim()),
        url: String(r.canonical_url).replace(/[?#].*$/, ''),
        date: new Date(r.post_date).toISOString().slice(0, 10),
      };
      if (!post.title || Number.isNaN(Date.parse(post.date))) throw new Error(`malformed api row: ${r.canonical_url}`);
      const subtitle = cap(curl(plain(String(r.subtitle ?? ''))));
      if (subtitle) post.subtitle = subtitle;
      return post;
    });
}

async function main() {
  const fresh = await fromFeed().catch((feedErr) =>
    fromApi().catch((apiErr) => {
      throw new Error(`${feedErr.message}; ${apiErr.message}`);
    }),
  );

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
  console.log(`substack: ${posts.length} posts (${added} new, ${fresh.length} in feed) → blog/posts.json`);
}

main().catch((err) => {
  console.error(`substack sync failed: ${err.message}`);
  process.exit(1);
});
