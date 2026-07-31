// Rebuilds blog/posts.json from the Substack RSS feed, and writes each public
// post as a page under blog/<slug>/ so the essays are read here, not there.
// Node 20+, no npm install: the only library is KaTeX, vendored under scripts/vendor/.
// Run by .github/workflows/substack-sync.yml, or by hand: node scripts/fetch-substack.mjs

import { readFile, writeFile, rename, unlink, mkdir, access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const SITE = 'https://jamesfbaker.substack.com';
const FEED = `${SITE}/feed`;
const BLOG = fileURLToPath(new URL('../blog/', import.meta.url));
const OUT = join(BLOG, 'posts.json');
const TEMPLATE = fileURLToPath(new URL('./post-template.html', import.meta.url));
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

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

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
// Titles and subtitles only — body prose keeps whatever the author typed.
const curl = (s) => s.replace(/'/g, '’');

// ---------------------------------------------------------------------------
// post body → article markup
//
// Substack ships editor scaffolding: subscribe forms, share buttons, four
// nested divs per image, LaTeX parked in data-attrs. None of it belongs here.
// ---------------------------------------------------------------------------

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
// tags whose whole subtree goes
const DROP = new Set(['script', 'style', 'iframe', 'form', 'noscript', 'svg', 'button', 'object', 'video', 'audio', 'canvas', 'select', 'textarea']);
// containers Substack uses for subscribe/share/paywall furniture
const FURNITURE = /(^|[\s"])(subscription-widget|subscribe-widget|button-wrapper|paywall|digest-post-embed|footer-cta|poll-embed|share-dialog)/;
// everything else that survives is unwrapped, children kept
const KEEP = new Set([
  'p', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'em', 'i', 'strong', 'b',
  'a', 'img', 'figure', 'figcaption', 'hr', 'br', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
  'sup', 'sub', 'del', 'ins', 'small', 'dl', 'dt', 'dd', 'u', 'abbr', 'cite', 'mark', 'time',
]);
const BLOCK = new Set(['p', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'figure', 'figcaption', 'hr', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'dl', 'dt', 'dd']);
// cells and list items hold structure even when empty: a blank <td> keeps a column open
const STRUCTURAL = new Set(['td', 'th', 'li']);
// paragraphs that are only a call to action
const CTA = /^(share( this post)?|leave a comment|comment|subscribe( now)?|give a gift subscription|refer a friend|restack|share james.*|thanks for reading\b[\s\S]*)$/i;
// Substack's boilerplate is always a line or two. A real closing paragraph that happens to
// open with "Thanks for reading" is prose, not furniture, so length decides.
const CTA_MAX = 160;

// Attribute values here carry both < and > (LaTeX lives inside data-attrs), so tags are
// scanned with quote awareness — /<[^>]*>/ shears a div in half on the Bayes post.
function tokenize(html) {
  const out = [];
  let i = 0;
  let text = '';
  const flush = () => { if (text) out.push({ kind: 'text', raw: text }); text = ''; };

  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) { text += html.slice(i); break; }
    text += html.slice(i, lt);
    if (html.startsWith('<!--', lt)) { // comments never survive
      const end = html.indexOf('-->', lt + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    const named = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)/.exec(html.slice(lt, lt + 24));
    if (!named) { text += '<'; i = lt + 1; continue; }
    let j = lt + 1;
    let quote = '';
    for (; j < html.length; j++) {
      const c = html[j];
      if (quote) { if (c === quote) quote = ''; }
      else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
    }
    if (j >= html.length) { text += html.slice(lt); break; } // unterminated tag: treat as text
    flush();
    const raw = html.slice(lt, j + 1);
    const name = named[2].toLowerCase();
    out.push({
      kind: 'tag',
      name,
      close: named[1] === '/',
      attrs: raw.slice(1 + named[1].length + name.length, -1).replace(/\/$/, ''),
    });
    i = j + 1;
  }
  flush();
  return out;
}

// Links are allowlisted, not denylisted. A denylist of `javascript:` misses data:, vbscript:
// and blob:, and is walked straight past by `java\tscript:` — browsers strip the control
// characters before reading the scheme, so this does too.
function linkable(href) {
  if (!href) return false;
  if (href.startsWith('//')) return true; // protocol-relative
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(href);
  return scheme ? ['http', 'https', 'mailto'].includes(scheme[1].toLowerCase()) : true; // else relative or #fragment
}

const attrOf = (attrs, name) => {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(attrs);
  return m ? (m[2] ?? m[3] ?? m[4] ?? '') : null;
};

// index just past the matching close tag of the open tag at `start`
function past(tokens, start) {
  const { name } = tokens[start];
  if (VOID.has(name)) return start + 1;
  let depth = 0;
  for (let i = start; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind !== 'tag' || t.name !== name) continue;
    if (t.close) { if (--depth <= 0) return i + 1; }
    else depth++;
  }
  // Never closed. Swallowing to the end would delete the rest of the essay over one stray
  // tag, so only the open tag is skipped and the remaining tokens get their normal pass.
  return start + 1;
}

const textOf = (tokens, from, to) =>
  decode(tokens.slice(from, to).filter((t) => t.kind === 'text').map((t) => t.raw).join('')).replace(/\s+/g, ' ').trim();

// substackcdn wraps the original in a fetch URL; the tail is the real image.
function original(url) {
  const m = /\/(https?%3a%2f%2f[^/\s]+)$/i.exec(url);
  if (!m) return '';
  try {
    const decoded = decodeURIComponent(m[1]);
    return /^https:\/\//i.test(decoded) ? decoded : '';
  } catch {
    return '';
  }
}

function imageSrc(attrs) {
  const src = attrOf(attrs, 'src') ?? '';
  // `[^\s,]` not `\S`: Substack sometimes omits the space after a srcset comma, and a
  // greedy \S+ then drags the comma into the next candidate's URL.
  const set = [...(attrOf(attrs, 'srcset') ?? '').matchAll(/([^\s,]+)\s+(\d+)w/g)]
    .map((m) => ({ url: m[1], w: Number(m[2]) }))
    .sort((a, b) => b.w - a.w);
  const widest = set[0]?.url ?? '';
  return original(src) || original(widest) || widest || src;
}

const open = (name, attrs = '') => ({ kind: 'raw', raw: `<${name}${attrs}>`, name, open: true });
const shut = (name) => ({ kind: 'raw', raw: `</${name}>`, name, close: true });

// <div class="captioned-image-container"><figure><a><div><picture>… → <figure><img><figcaption>
function figure(tokens, start, end) {
  const img = tokens.slice(start, end).find((t) => t.kind === 'tag' && t.name === 'img' && !t.close);
  if (!img) return [];
  const src = imageSrc(img.attrs);
  if (!src) return [];
  const capOpen = tokens.findIndex((t, i) => i >= start && i < end && t.kind === 'tag' && t.name === 'figcaption' && !t.close);
  const caption = capOpen < 0 ? '' : textOf(tokens, capOpen + 1, past(tokens, capOpen) - 1);
  const alt = decode(attrOf(img.attrs, 'alt') ?? '');
  return [
    open('figure'),
    open('img', ` src="${esc(src)}" alt="${esc(alt)}" loading="lazy"`),
    ...(caption ? [open('figcaption'), { kind: 'text', raw: caption }, shut('figcaption')] : []),
    shut('figure'),
  ];
}

// KaTeX is vendored under scripts/vendor/, the way three.js sits in js/: a build-time tool in
// a repo with no package.json and no install step. It is UMD, so it arrives through require.
const require = createRequire(import.meta.url);
let katex; // loaded at the first equation — most posts have none and should not pay for it

// TeX → the bare <math> element, or '' if KaTeX could not parse it. Only MathML is asked for
// and only MathML is kept: the span.katex wrapper exists to be styled by a stylesheet that no
// reader here loads, while the <math> inside needs every attribute it was given (xmlns, the
// display mode, mathvariant, the annotation's encoding) to mean anything. On a parse error
// KaTeX emits a span.katex-error holding the raw TeX and no <math> at all, which lands here
// as '' and sends the caller to the fallback.
function mathml(tex, display) {
  // Deliberately outside the catch: a missing vendored KaTeX is a broken checkout, not a
  // broken equation, and it has to stop the run rather than quietly rewrite every formula
  // on the site as a block of TeX and commit that.
  katex ??= require('./vendor/katex.min.js');
  try {
    const rendered = katex.renderToString(tex, { output: 'mathml', displayMode: display, throwOnError: false, strict: 'ignore' });
    return /<math[\s>][\s\S]*<\/math>/.exec(rendered)?.[0] ?? '';
  } catch (err) {
    console.warn(`  katex: ${err.message}`);
    return '';
  }
}

// A rendered equation waits in the token stream as this: no entities and no tag syntax, so
// passes 2–4 carry it through as ordinary text. The MathML replaces it only once those passes
// are done — injected any earlier, the attribute strip would take the xmlns and the display
// with it and leave a row of letters behind. The U+0001 delimiters are what stop an author's
// own code block, if one ever reads `math:0`, from being swapped out for somebody's equation.
const slot = (i) => `math:${i}`;
const SLOTS = /<pre><code>math:(\d+)<\/code><\/pre>/g;

// Substack parks the expression in data-attrs and renders it client-side; there is no client
// here, so it is rendered here instead, at build time, into markup the browser draws on its
// own. The TeX is the author's — it gets rendered, never corrected.
function latex(attrs, maths) {
  let tex = '';
  try {
    tex = String(JSON.parse(decode(attrOf(attrs, 'data-attrs') ?? '{}')).persistentExpression ?? '');
  } catch {
    tex = '';
  }
  tex = tex.replace(/\r/g, '').replace(/\n{2,}/g, '\n').trim();
  if (!tex) return [];

  // Everything Substack ships today is a block (data-component-name="LatexBlockToDOM"); an
  // inline one, if it ever comes, sets itself apart by name and must not break the line.
  const kind = `${attrOf(attrs, 'class') ?? ''} ${attrOf(attrs, 'data-component-name') ?? ''}`;
  const math = mathml(tex, !/inline/i.test(kind));
  if (!math) {
    // Unrenderable: the TeX itself is still the honest thing to show, as it was before.
    console.warn(`  equation left as TeX: ${JSON.stringify(tex.slice(0, 60))}`);
    return [open('pre'), open('code'), { kind: 'text', raw: tex }, shut('code'), shut('pre')];
  }
  maths.push(math);
  return [open('pre'), open('code'), { kind: 'text', raw: slot(maths.length - 1) }, shut('code'), shut('pre')];
}

function article(raw) {
  const src = tokenize(raw);
  const kept = [];
  const maths = []; // rendered equations, held back until the escaping passes are over

  // pass 1 — drop furniture, rewrite images and formulas
  for (let i = 0; i < src.length;) {
    const t = src[i];
    if (t.kind !== 'tag' || t.close) { kept.push(t); i++; continue; }
    const cls = attrOf(t.attrs, 'class') ?? '';
    if (DROP.has(t.name) || FURNITURE.test(cls)) { i = past(src, i); continue; }
    if (VOID.has(t.name) && t.name !== 'img' && t.name !== 'br' && t.name !== 'hr') { i++; continue; }
    if (/(^|[\s"])captioned-image-container/.test(cls) || t.name === 'figure') {
      const end = past(src, i);
      kept.push(...figure(src, i, end));
      i = end;
      continue;
    }
    if (/(^|[\s"])latex-rendered/.test(cls)) {
      const end = past(src, i);
      kept.push(...latex(t.attrs, maths));
      i = end;
      continue;
    }
    kept.push(t);
    i++;
  }

  // pass 2 — strip attributes, demote h1, unwrap everything off the keep list
  const clean = [];
  const anchors = []; // a dropped <a> must take its </a> with it
  for (const t of kept) {
    if (t.kind !== 'tag') { clean.push(t); continue; }
    const name = t.name === 'h1' ? 'h2' : t.name;
    if (t.close) {
      if (name === 'a' && anchors.pop() === false) continue;
      if (KEEP.has(name)) clean.push(shut(name)); // div, span, picture… children survive
      continue;
    }
    if (!KEEP.has(name)) continue;
    let attrs = '';
    if (name === 'a') {
      const href = decode(attrOf(t.attrs, 'href') ?? '').replace(/[\u0000-\u0020]/g, '');
      anchors.push(linkable(href));
      if (!anchors[anchors.length - 1]) continue; // unfollowable: the anchor goes, its text stays
      attrs = ` href="${esc(href)}"`;
    } else if (name === 'img') {
      const src = imageSrc(t.attrs);
      if (!src) continue;
      attrs = ` src="${esc(src)}" alt="${esc(decode(attrOf(t.attrs, 'alt') ?? ''))}" loading="lazy"`;
    } else if (name === 'time') {
      const dt = attrOf(t.attrs, 'datetime');
      attrs = dt ? ` datetime="${esc(dt)}"` : '';
    }
    clean.push(open(name, attrs));
  }

  // pass 3 — drop empty and call-to-action blocks, repeatedly (nesting collapses inward)
  let tokens = clean;
  for (let round = 0; round < 4; round++) {
    const next = [];
    let cut = false;
    for (let i = 0; i < tokens.length;) {
      const t = tokens[i];
      const isOpen = (t.kind === 'raw' || t.kind === 'tag') && t.open && BLOCK.has(t.name) && !STRUCTURAL.has(t.name);
      if (!isOpen) { next.push(t); i++; continue; }
      const end = closes(tokens, i);
      if (end < 0) { next.push(t); i++; continue; }
      const inner = tokens.slice(i + 1, end);
      const text = inner.filter((x) => x.kind === 'text').map((x) => x.raw).join('');
      const solid = inner.some((x) => x.kind !== 'text' && ['img', 'hr', 'br'].includes(x.name));
      const bare = decode(text).replace(/\s+/g, ' ').trim();
      if (!solid && (!bare || (t.name === 'p' && bare.length <= CTA_MAX && CTA.test(bare)))) { i = end + 1; cut = true; continue; }
      next.push(t);
      i++;
    }
    tokens = next;
    if (!cut) break;
  }

  // pass 4 — serialise: text decoded then re-escaped, one block element per line
  let out = '';
  let pre = 0;
  for (const t of tokens) {
    if (t.kind === 'text') { out += esc(decode(t.raw)); continue; }
    const inside = pre; // no reflowing inside preformatted text
    if (t.name === 'pre') pre += t.close ? -1 : 1;
    if (!inside && BLOCK.has(t.name) && t.open && !out.endsWith('\n')) out += '\n';
    out += t.raw;
    if (!pre && BLOCK.has(t.name) && t.close) out += '\n';
  }

  // The blank-line squeeze below tidies this generator's own layout. Inside a code block a
  // blank line is the author's, so pre bodies are held out of the pass: splitting on a
  // captured group parks them at the odd indices, untouched, and join stitches them back.
  // (Text is escaped by now, so a literal `</pre>` cannot occur outside a real close tag.)
  return out
    .split(/(<pre>[\s\S]*?<\/pre>)/)
    .map((part, i) => (i % 2 ? part : part.replace(/\n{2,}/g, '\n')))
    .join('')
    .trim()
    // pass 5 — the equations land last, past everything that would have sanitised them away.
    .replace(SLOTS, (raw, i) => maths[i] ?? raw);
}

// index of the close tag matching the open token at `start`, or -1
function closes(tokens, start) {
  const { name } = tokens[start];
  let depth = 0;
  for (let i = start; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind === 'text' || t.name !== name) continue;
    if (t.close) { if (--depth <= 0) return i; }
    else depth++;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// pages
// ---------------------------------------------------------------------------

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const human = (iso) => {
  const [y, m, d] = iso.split('-');
  return `${MONTHS[+m - 1]} ${+d}, ${y}`;
};

// `posts.json` and the index live in blog/ too, and a slug is a directory name.
const RESERVED = new Set(['posts.json', 'index.html', 'open.html', 'nine-dots-puzzle.js']);

const slugOf = (url) => (url.match(/\/p\/([^/?#]+)/)?.[1] ?? '').trim();

// A slug becomes a directory name, so it has to start alphanumeric and hold nothing but word
// characters and dashes. The old /^[\w.-]+$/ admitted '.' and '..' — a slug of '.' resolves
// to blog/ itself and writes blog/index.html, i.e. the archive page, over with one essay.
const usable = (slug) => Boolean(slug) && !RESERVED.has(slug) && /^[a-z0-9][\w-]*$/i.test(slug);

function page(template, post, slug, body) {
  const description = post.subtitle || post.title;
  const values = {
    title: esc(post.title),
    description: esc(description),
    subtitle_block: post.subtitle ? `\t<p class="subtitle">${esc(post.subtitle)}</p>` : '',
    date_iso: post.date,
    date_human: human(post.date),
    content: body,
    substack_url: esc(post.url),
    slug: esc(slug),
  };
  return template.replace(/\{\{(\w+)\}\}/g, (raw, key) => {
    if (!(key in values)) throw new Error(`post-template.html has an unknown placeholder {{${key}}}`);
    return values[key];
  });
}

async function writeAtomic(file, contents) {
  // Write to a sibling then rename: a crashed run must never leave a half-written file.
  // The pid keeps two concurrent runs (the workflow and the local sync overlap by minutes)
  // off each other's scratch file. *.tmp is gitignored at the repo root.
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, contents);
    await rename(tmp, file);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

const exists = (file) => access(file).then(() => true, () => false);

// ---------------------------------------------------------------------------
// images
//
// An essay outlives the CDN that happens to be holding its pictures, so each one is
// pulled into the post's own directory and referenced by bare filename.
// ---------------------------------------------------------------------------

// Substack ships some images with alt="" — decorative markup for a picture that is carrying
// argument. Written by hand here, keyed by filename, so a regeneration cannot lose them.
const ALT_OVERRIDES = {
  'd2b2486c-2118-40f4-ad5c-b593c362ca13_1150x404.png':
    'Screenshot of a tweet by Andrej Karpathy, 29 January 2025: “For friends of open source: imo the '
    + 'highest leverage thing you can do is help construct a high diversity of RL environments that help '
    + 'elicit LLM cognitive strategies. To build a gym of sorts.”',
};

const IMAGE = /\.(png|jpe?g|gif|webp|avif|svg)$/i;

// The basename of the URL path, cut down to what is safe as a filename on any OS.
function imageName(url) {
  let base;
  try {
    base = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
  } catch {
    return '';
  }
  base = base.replace(/[^\w.-]+/g, '-').replace(/^[.-]+/, '').slice(-100);
  return IMAGE.test(base) ? base : '';
}

// Rewrites every remote <img> in `body` to a file sitting next to the page. Idempotent: an
// image already on disk is not fetched again. A download that fails keeps its remote src —
// a picture served from someone else's CDN beats no picture at all.
async function localize(body, slug) {
  const dir = join(BLOG, slug);
  const local = new Map(); // remote url → local filename
  const taken = new Set();

  for (const [, raw] of body.matchAll(/<img src="([^"]+)"/g)) {
    const url = decode(raw);
    if (!/^https:\/\//i.test(url) || local.has(url)) continue;
    const base = imageName(url);
    if (!base) {
      console.warn(`  ${slug}: no usable filename in ${url} — leaving it remote`);
      continue;
    }
    let name = base;
    for (let n = 2; taken.has(name); n++) name = base.replace(/(\.[^.]*)$/, `-${n}$1`);
    if (!(await exists(join(dir, name)))) {
      try {
        const res = await attempt(url);
        await mkdir(dir, { recursive: true });
        await writeAtomic(join(dir, name), Buffer.from(await res.arrayBuffer()));
        console.log(`  ${slug}: saved ${name}`);
      } catch (err) {
        console.warn(`  ${slug}: could not fetch ${url} (${err.message}) — leaving it remote`);
        continue;
      }
    }
    taken.add(name);
    local.set(url, name);
  }
  if (!local.size) return body;

  // Both emitters (pass 2 and figure()) write this exact shape, so the match can be exact.
  return body.replace(/<img src="([^"]+)" alt="([^"]*)" loading="lazy">/g, (whole, src, alt) => {
    const name = local.get(decode(src));
    return name ? `<img src="${esc(name)}" alt="${esc(ALT_OVERRIDES[name] ?? decode(alt))}" loading="lazy">` : whole;
  });
}

// git's autocrlf hands these files back with CRLF on windows; a checkout is not a change.
const same = (onDisk, fresh) => onDisk !== null && onDisk.replace(/\r\n/g, '\n') === fresh;

// what a rendered page or body actually reads as, in characters
const visible = (html) => plain(html).length;

// Posts that age out of the feed keep their pages; nothing here ever deletes.
async function pages(posts, bodies) {
  const template = await readFile(TEMPLATE, 'utf8');
  const tally = { written: 0, unchanged: 0, skipped: 0, guarded: 0 };
  const claimed = new Set(); // one slug, one directory: posts are sorted, so the first wins

  for (const post of posts) {
    // Written here by hand, not pulled from the feed: its page is committed, so there is
    // nothing to generate, and slugOf would read no slug out of a deskofjim.com URL and
    // strip the good one the entry already carries.
    if (post.local) { tally.unchanged++; continue; }
    const slug = slugOf(post.url);
    if (!usable(slug)) {
      delete post.slug;
      tally.skipped++;
      console.warn(`  skipped ${post.url}: unusable slug ${JSON.stringify(slug)}`);
      continue;
    }
    if (claimed.has(slug)) {
      delete post.slug; // two posts, one directory — the later one links out to Substack
      tally.skipped++;
      console.warn(`  skipped ${post.url}: slug ${JSON.stringify(slug)} is already another post's directory`);
      continue;
    }
    claimed.add(slug);

    const file = join(BLOG, slug, 'index.html');
    let body = article(bodies.get(post.url) ?? '');
    if (body) {
      body = await localize(body, slug);
      const next = page(template, post, slug, body);
      const onDisk = await readFile(file, 'utf8').catch(() => null);
      if (same(onDisk, next)) tally.unchanged++;
      else {
        // A feed that hands back a truncated or paywalled body would otherwise quietly
        // replace a good committed page with a stub. Losing a day's update beats that.
        const had = onDisk === null ? 0 : visible(onDisk.match(/<article>([\s\S]*?)<\/article>/)?.[1] ?? '');
        const now = visible(body);
        if (had && now * 2 < had) {
          console.warn(`  !! ${slug}: new body reads as ${now} chars against ${had} on disk — refusing to overwrite; check the feed`);
          tally.guarded++;
          post.slug = slug;
          continue;
        }
        await mkdir(join(BLOG, slug), { recursive: true });
        await writeAtomic(file, next);
        tally.written++;
      }
      post.slug = slug;
    } else if (await exists(file)) {
      tally.unchanged++; // no content this run (older post, or feed gave none) — the page stands
      post.slug = slug;
    } else {
      delete post.slug; // no page: the index links this one out to Substack
      tally.skipped++;
    }
  }
  return tally;
}

// ---------------------------------------------------------------------------
// sources
// ---------------------------------------------------------------------------

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
    post.html = field(item, 'content:encoded');
    return post;
  });
}

// Same posts, Substack's JSON API — a second door for when the CDN dislikes the first.
async function fromApi() {
  const res = await attempt(`${SITE}/api/v1/posts?limit=50`);
  const rows = await res.json();
  if (!Array.isArray(rows) || !rows.length) throw new Error('api returned no posts');

  return rows
    // Allowlisted, not denylisted: `founding`, `only_free` and friends all ship a truncated
    // preview as body_html, and a preview published as a whole essay is a lie on the page.
    .filter((r) => r.post_date && r.canonical_url && (r.audience ?? 'everyone') === 'everyone')
    .map((r) => {
      const post = {
        title: curl(decode(String(r.title ?? '')).trim()),
        url: String(r.canonical_url).replace(/[?#].*$/, ''),
        date: new Date(r.post_date).toISOString().slice(0, 10),
      };
      if (!post.title || Number.isNaN(Date.parse(post.date))) throw new Error(`malformed api row: ${r.canonical_url}`);
      const subtitle = cap(curl(plain(String(r.subtitle ?? ''))));
      if (subtitle) post.subtitle = subtitle;
      post.html = String(r.body_html ?? '');
      return post;
    });
}

async function main() {
  const fresh = await fromFeed().catch((feedErr) =>
    fromApi().catch((apiErr) => {
      throw new Error(`${feedErr.message}; ${apiErr.message}`);
    }),
  );

  // Bodies never enter posts.json — they go straight to the pages.
  const bodies = new Map();
  for (const post of fresh) {
    if (post.html) bodies.set(post.url, post.html);
    delete post.html;
  }

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

  // Pages first: a post only carries a slug once its page is on disk, so the index
  // never links to a directory that does not exist.
  const tally = await pages(posts, bodies);
  const built = `pages ${tally.written} written / ${tally.unchanged} unchanged${tally.skipped ? ` / ${tally.skipped} without one` : ''}${tally.guarded ? ` / ${tally.guarded} held back` : ''}`;

  const stale = JSON.stringify(posts) !== JSON.stringify(previous.posts ?? []);
  const generated = stale || !previous.generated ? new Date().toISOString().replace(/\.\d+Z$/, 'Z') : previous.generated;
  const out = JSON.stringify({ source: FEED, generated, posts }, null, 2) + '\n';
  if (same(before, out)) {
    console.log(`substack: ${posts.length} posts, unchanged; ${built}`);
    return;
  }

  await writeAtomic(OUT, out);
  console.log(`substack: ${posts.length} posts (${added} new, ${fresh.length} in feed) → blog/posts.json; ${built}`);
}

main().catch((err) => {
  console.error(`substack sync failed: ${err.message}`);
  process.exit(1);
});
