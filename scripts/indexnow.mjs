import process from 'node:process';
import { URL, pathToFileURL } from 'node:url';

const HOST = 'creditcardandy.com';
export const INDEXNOW_KEY = 'e3de8be5a7be9d67b95e519be477a001';
const ORIGIN = `https://${HOST}`;
const KEY_LOCATION = `${ORIGIN}/${INDEXNOW_KEY}.txt`;
const TIMEOUT = 30_000;
const { AbortSignal, console, fetch } = globalThis;

function siteUrl(value) {
  try {
    const url = new URL(value);
    if (url.origin === ORIGIN && !url.username && !url.password) {
      url.hash = '';
      return url.href;
    }
  } catch {
    return undefined;
  }
}

function parseArgs(argv) {
  const options = {
    since: Date.now() - 3 * 86_400_000,
    all: false,
    dryRun: false,
    urls: [],
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--all') options.all = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--since') {
      const value = argv[++index];
      const day = value?.slice(0, 10);
      const midnight = new Date(`${day}T00:00:00Z`);
      if (
        !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(
          value ?? '',
        ) ||
        !Number.isFinite(+midnight) ||
        midnight.toISOString().slice(0, 10) !== day
      ) {
        throw new Error(
          '--since requires an ISO date or timestamp, e.g. 2026-10-01.',
        );
      }
      options.since = Date.parse(value);
      if (!Number.isFinite(options.since))
        throw new Error('Invalid --since timestamp.');
    } else if (arg === '--url') {
      const url = siteUrl(argv[++index]);
      if (!url) throw new Error(`--url requires a URL on ${ORIGIN}.`);
      options.urls.push(url);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function decodeXml(text) {
  const entities = { amp: '&', lt: '<', gt: '>', apos: "'", quot: '"' };
  return text.replace(
    /&(amp|lt|gt|apos|quot|#x[\da-f]+|#\d+);/gi,
    (entity, name) => {
      if (!name.startsWith('#')) return entities[name] ?? entity;
      const codePoint =
        name[1].toLowerCase() === 'x'
          ? parseInt(name.slice(2), 16)
          : Number(name.slice(1));
      return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
    },
  );
}

function entries(xml, tag) {
  const blocks = new RegExp(
    `<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}\\s*>`,
    'g',
  );
  return [...xml.replace(/<!--[\s\S]*?-->/g, '').matchAll(blocks)].flatMap(
    ([, block]) => {
      const loc = block.match(/<loc\s*>([^<]+)<\/loc\s*>/)?.[1].trim();
      if (!loc) return [];
      return [
        {
          loc: decodeXml(loc),
          lastmod: block.match(/<lastmod\s*>([^<]+)<\/lastmod\s*>/)?.[1].trim(),
        },
      ];
    },
  );
}

export function sitemapEntries(xml) {
  return entries(xml, 'url');
}

async function fetchSitemap(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) });
  if (response.status === 404 || response.status === 410) return null;
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}.`);
  if (!siteUrl(response.url))
    throw new Error(`${url} redirected off ${ORIGIN}.`);
  return response.text();
}

async function collectSitemapEntries() {
  const xml =
    (await fetchSitemap(`${ORIGIN}/sitemap.xml`)) ??
    (await fetchSitemap(`${ORIGIN}/sitemap-index.xml`));
  if (!xml)
    throw new Error('No live sitemap; use --url to submit specific URLs.');
  if (/<sitemapindex[\s>]/.test(xml)) {
    const locations = [
      ...new Set(
        entries(xml, 'sitemap')
          .map(({ loc }) => siteUrl(loc))
          .filter(Boolean),
      ),
    ];
    const children = await Promise.all(
      locations.map(async (url) => {
        const child = await fetchSitemap(url);
        if (!child || !/<urlset[\s>]/.test(child))
          throw new Error(`${url} is not a sitemap URL set.`);
        return sitemapEntries(child);
      }),
    );
    return children.flat();
  }
  if (!/<urlset[\s>]/.test(xml))
    throw new Error('The live sitemap is not a sitemap URL set or index.');
  return sitemapEntries(xml);
}

async function keyIsLive() {
  try {
    const response = await fetch(KEY_LOCATION, {
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT),
    });
    return response.ok && (await response.text()) === INDEXNOW_KEY;
  } catch {
    return false;
  }
}

async function submit({ since, all, dryRun, urls }) {
  const keyLive = keyIsLive();
  let candidates = [];
  try {
    candidates = (await collectSitemapEntries())
      .map(({ loc, lastmod }) => ({ url: siteUrl(loc), lastmod }))
      .filter(({ url }) => url);
  } catch (error) {
    console.warn(`IndexNow: ${error.message}`);
  }

  const hasLastmod = candidates.some(({ lastmod }) => lastmod);
  const sitemapUrls = candidates
    .filter(({ lastmod }) => all || !hasLastmod || Date.parse(lastmod) >= since)
    .map(({ url }) => url);
  const urlList = [...new Set([...urls, ...sitemapUrls])].slice(0, 10_000);
  console.log(
    `IndexNow: ${candidates.length} sitemap entries, ${urlList.length} URL(s) selected.`,
  );

  if (!(await keyLive)) {
    console.warn(
      `IndexNow: key not live yet at ${KEY_LOCATION}; nothing sent.`,
    );
    return;
  }
  if (dryRun) {
    console.log('IndexNow: key verified; dry run, nothing sent.');
    return;
  }
  if (urlList.length === 0) return;

  const response = await fetch('https://api.indexnow.org/indexnow', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      host: HOST,
      key: INDEXNOW_KEY,
      keyLocation: KEY_LOCATION,
      urlList,
    }),
    redirect: 'error',
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const log =
    response.status === 200 || response.status === 202
      ? console.log
      : console.warn;
  log(`IndexNow: ${urlList.length} URL(s), HTTP ${response.status}.`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await submit(parseArgs(process.argv.slice(2))).catch((error) =>
      console.warn(`IndexNow: ${error.message}`),
    );
  } catch (error) {
    console.error(`IndexNow: ${error.message}`);
    process.exitCode = 1;
  }
}
