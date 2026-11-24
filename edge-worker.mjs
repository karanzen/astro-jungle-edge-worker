#!/usr/bin/env node
/**
 * Astro Jungle Edge — browser worker for JavaScript-rendered competitor sites (e.g. Best Al-Yousifi, Eureka).
 * Runs anywhere with Node 18+ (your PC, a small VPS, or a free GitHub Actions schedule). Shared web hosting cannot run this.
 *
 *   npm i playwright && npx playwright install chromium
 *   node edge-worker.mjs --endpoint https://YOUR-EDGE-SITE/wp-json/aje/v1 --key <source API key> [--limit 300] [--concurrency 2]
 *
 * Reads the source config from the plugin, collects product URLs from the sitemap (include/exclude regex from the plugin),
 * renders each page, extracts name/price/stock (JSON-LD -> configured CSS selectors -> currency regex), and posts batches to /ingest.
 * Public pages only, one page at a time per browser context, polite delay. Nothing is written to the competitor site.
 */
import { chromium } from 'playwright';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const ENDPOINT = (arg('--endpoint', '') || '').replace(/\/$/, '');
const KEY = arg('--key', '');
const LIMIT = parseInt(arg('--limit', '0'), 10);
const DEBUG = process.argv.includes('--debug');
const CONC = Math.max(1, Math.min(4, parseInt(arg('--concurrency', '2'), 10)));
if (!ENDPOINT || !KEY) { console.error('Usage: node edge-worker.mjs --endpoint <url>/wp-json/aje/v1 --key <api key>'); process.exit(1); }

// QUIET: on CI the run log is public for a public repo, so never print the client, the site or any URL — only counts.
const QUIET = !!process.env.CI && !process.argv.includes('--verbose');
const h = (u) => QUIET ? '[url]' : u;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// API calls retry on server hiccups (5xx, network) — a single bad response must not kill a multi-hour crawl.
const api = async (path, opts = {}, tries = 4) => {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(ENDPOINT + path, { ...opts, headers: { 'Content-Type': 'application/json', 'X-AJE-Key': KEY, ...(opts.headers || {}) } });
      if (!r.ok) { const body = (await r.text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 160); const e = new Error(`${path} -> HTTP ${r.status}: ${body}`); e.retry = r.status >= 500 || r.status === 429; throw e; }
      return r.json();
    } catch (e) {
      if (i >= tries || e.retry === false) throw e;
      const wait = 15000 * i; console.log(`  ${path} failed (${e.message.slice(0, 120)}) — retrying in ${wait / 1000}s`); await sleep(wait);
    }
  }
};
const num = (s) => { if (s == null) return null; const m = String(s).replace(/,/g, '').match(/\d+(?:\.\d+)?/); return m ? parseFloat(m[0]) : null; };

async function sitemapUrls(cfg) {
  const inc = cfg.url_include ? new RegExp(cfg.url_include, 'i') : null;
  const exc = cfg.url_exclude ? new RegExp(cfg.url_exclude, 'i') : null;
  const limit = Math.max(LIMIT || 0, cfg.max_urls || 1000);
  const seen = new Set(); const out = new Set(); const queue = [cfg.sitemap_url];
  while (queue.length) {
    const u = queue.shift(); if (!u || seen.has(u)) continue; seen.add(u);
    let body; try { body = await (await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AstroJungleEdge/0.2)' } })).text(); } catch { continue; }
    const isIndex = /<sitemapindex/i.test(body);
    for (const m of body.matchAll(/<loc>\s*(.*?)\s*<\/loc>/gis)) {
      const loc = m[1].replace(/&amp;/g, '&').trim();
      if (isIndex) { queue.push(loc); continue; }
      if (inc && !inc.test(loc)) continue; if (exc && exc.test(loc)) continue;
      out.add(loc);
    }
  }
  let list = [...out];
  // If URLs end in a numeric id (e.g. /details/276373), take the newest first: old ids are usually discontinued.
  const idOf = (u) => { const m = u.match(/(\d{3,})(?:[/?#].*)?$/); return m ? parseInt(m[1], 10) : null; };
  const numeric = list.filter((u) => idOf(u) !== null).length;
  if (list.length && numeric / list.length > 0.9) list.sort((a, b) => (idOf(b) || 0) - (idOf(a) || 0));
  console.log(`${list.length} URLs in sitemap after filters${numeric / Math.max(1, list.length) > 0.9 ? ', newest first' : ''}`);
  return list.slice(0, limit);
}

async function extract(page, url, cfg) {
  const sel = cfg.selectors || {};
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  try { if (sel.wait) await page.waitForSelector(sel.wait, { timeout: 15000 }); else await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch {}
  // client-rendered shops: wait until the price element actually carries a number (up to 10 s)
  if (sel.price) { try { await page.waitForFunction((q) => [...document.querySelectorAll(q)].some((e) => /\d/.test(e.textContent)), sel.price, { timeout: 10000 }); } catch {} }
  await sleep(600);
  return page.evaluate(({ sel, currency }) => {
    const out = { url: location.href };
    const txt = (q, needDigit) => { if (!q) return null; const els = [...document.querySelectorAll(q)].filter((e) => e.textContent.trim() && (!needDigit || /\d/.test(e.textContent))); return els.length ? els[0].textContent.trim() : null; };
    // 1. JSON-LD
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const j = JSON.parse(s.textContent); const nodes = j['@graph'] || (Array.isArray(j) ? j : [j]);
        for (const n of nodes) {
          const t = Array.isArray(n['@type']) ? n['@type'].join(',') : (n['@type'] || '');
          if (!/Product/i.test(t)) continue;
          let of = n.offers || {}; if (Array.isArray(of)) of = of[0] || {};
          const ldPrice = parseFloat(String(of.price ?? of.lowPrice ?? '').replace(/,/g, ''));
          if (!(ldPrice > 0)) continue; // placeholder JSON-LD (price 0) — fall through to selectors
          out.title = n.name; out.sku = (n.sku && n.sku !== '0') ? n.sku : n.mpn; out.brand = n.brand && (n.brand.name || n.brand); out.image = Array.isArray(n.image) ? n.image[0] : (n.image && n.image.url) || n.image;
          out.price = ldPrice; out.available = !of.availability || /InStock|PreOrder/i.test(of.availability);
        }
      } catch {}
    }
    // 2. configured selectors
    if (sel.title && (!out.title || out.title === '0')) out.title = txt(sel.title) || out.title;
    if (out.price == null && sel.price) out.price = txt(sel.price, true);
    if (sel.oos && document.querySelector(sel.oos)) out.available = false;
    // 3. meta / heuristics
    const meta = (p) => { const e = document.querySelector(`meta[property="${p}"],meta[name="${p}"],meta[itemprop="${p.split(':').pop()}"]`); return e ? e.content : null; };
    if (out.price == null) out.price = meta('product:price:amount') || meta('og:price:amount') || meta('price');
    if (!out.title) out.title = txt('h1') || meta('og:title') || document.title.replace(/\s*[|\-–].*$/, '');
    if (!out.image) out.image = meta('og:image');
    if (out.price == null) {
      const body = document.body.innerText;
      const re1 = new RegExp('(?:' + currency + '|KWD|KD)\\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\\.[0-9]{1,3})?)', 'i');
      const re2 = new RegExp('([0-9]{1,3}(?:,[0-9]{3})*\\.[0-9]{3})\\s*(?:' + currency + '|KWD|KD)\\b', 'i');
      const m = body.match(re1) || body.match(re2); if (m) out.price = m[1];
      if (out.available == null) out.available = !/\b(out of stock|sold out|notify me)\b/i.test(body);
    }
    if (out.available == null) out.available = !/\b(out of stock|sold out|notify me)\b/i.test(document.body.innerText);
    if (!out.sku) { const m = location.pathname.match(/\/p\/([^/?#]+)|\/details\/(\d+)/); out.sku = m ? decodeURIComponent(m[1] || m[2]) : null; }
    return out;
  }, { sel, currency: cfg.currency || 'KD' });
}


/**
 * Listing mode: read category pages (many products + prices per page) instead of one product page each.
 * cfg.selectors: { listing: "url per line", ltitle, lprice, paging: "scroll" | "param:<name>" | "none", more: css of a "load more" button, lcard (optional) }
 */
async function crawlListing(page, cfg, onProduct) {
  const sel = cfg.selectors || {}; const base = (cfg.base_url || '').replace(/\/$/, '');
  const abs = (u) => (u.startsWith('http') ? u : base + (u.startsWith('/') ? '' : '/') + u);
  let urls = String(sel.listing || '').split(/\s+/).map((u) => u.trim()).filter(Boolean).map(abs);
  // Optional discovery: visit the home page (and the listed pages) and add every link matching the regex → maximum category coverage.
  if (sel.ldiscover) {
    const re = new RegExp(sel.ldiscover, 'i'); const found = new Set(urls);
    const seeds = [base + '/', ...urls.slice(0, 30)];
    for (const seed of seeds) {
      try {
        await page.goto(seed, { waitUntil: 'domcontentloaded', timeout: 45000 }); await sleep(2500);
        const hrefs = await page.evaluate(() => [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')));
        for (const h of hrefs) { if (!h) continue; const u = abs(h.split('#')[0]); const rel = u.replace(base, ''); if (re.test(rel) || re.test(u)) found.add(u.replace(/\/$/, '')); }
      } catch (e) { console.log(`  discover fail ${h(seed)}: ${e.message.split('\n')[0]}`); }
      await sleep(cfg.delay_ms || 600);
    }
    urls = [...found];
    console.log(`  ${urls.length} listing pages after discovery`);
  }
  const paging = String(sel.paging || 'scroll'); const seen = new Set(); let total = 0;
  const readCards = () => page.evaluate(({ ltitle, lprice, lcard }) => {
    const items = [];
    for (const t of document.querySelectorAll(ltitle)) {
      let card = t;
      if (lcard) card = t.closest(lcard);
      else for (let k = 0; k < 8 && card; k++) { if (card.querySelector(lprice)) break; card = card.parentElement; }
      if (!card) continue;
      const pe = [...card.querySelectorAll(lprice)].find((e) => /\d/.test(e.textContent) && !e.closest('.ng-hide') && e.offsetParent !== null) || [...card.querySelectorAll(lprice)].find((e) => /\d/.test(e.textContent));
      const a = t.closest('a[href]') || card.querySelector('a[href]');
      const href = a ? a.href : null;
      let title = t.tagName === 'A' ? '' : t.textContent.trim();
      if (!title || (pe && pe.textContent && title.includes(pe.textContent.trim()))) { // anchor used as title source: image alt, else URL slug
        const img = t.querySelector('img[alt]') || card.querySelector('img[alt]');
        title = (img && img.alt.trim().length > 8) ? img.alt.trim() : '';
        if (!title && href) { const seg = href.split('?')[0].replace(/\/p$/, '').split('/').filter(Boolean).pop() || ''; title = decodeURIComponent(seg).replace(/\b(\d)-(\d)\b/g, '$1.$2').replace(/[-_]+/g, ' ').replace(/\b([a-z])/g, (m) => m.toUpperCase()); }
      }
      items.push({ title, price: pe ? pe.textContent.trim() : null, url: href, available: !/\b(out of stock|sold out|notify me)\b/i.test(card.innerText) });
    }
    return items;
  }, { ltitle: sel.ltitle || 'a', lprice: sel.lprice || '.price', lcard: sel.lcard || null });
  const collect = async (items, pageUrl) => {
    let n = 0;
    for (const it of items) {
      const price = num(it.price); if (!it.title || !price || !it.url) continue;
      const m = it.url.match(/\/p\/([^/?#]+)|\/details\/(\d+)/); const key = m ? decodeURIComponent(m[1] || m[2]) : it.url;
      if (seen.has(key)) continue; seen.add(key); n++;
      await onProduct({ key, title: it.title.replace(/\s+/g, ' ').slice(0, 300), price, available: it.available, url: it.url.split('?')[0], sku: m ? key : undefined });
    }
    return n;
  };
  for (const url of urls) {
    if (!QUIET) console.log(`  listing ${url}`);
    try {
      if (paging.startsWith('param:')) {
        const name = paging.slice(6); let p = 0, empty = 0;
        while (p < 200) {
          const u = p === 0 ? url : url + (url.includes('?') ? '&' : '?') + name + '=' + p;
          await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 45000 });
          try { await page.waitForSelector(sel.ltitle, { timeout: 15000 }); } catch {}
          await sleep(800);
          const items = await readCards(page); const n = await collect(items, u); total += n;
          if (DEBUG) console.log(`    page ${p}: ${items.length} cards, ${n} new`);
          if (!items.length || n === 0) { if (++empty >= 2) break; } else empty = 0;
          p++; await sleep(cfg.delay_ms || 600);
        }
      } else {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        try { await page.waitForSelector(sel.ltitle, { timeout: 15000 }); } catch {}
        let last = -1, stable = 0;
        for (let k = 0; k < 150 && paging !== 'none'; k++) {
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
          await sleep(1200);
          if (sel.more) { try { const b = await page.$(sel.more); if (b && (await b.isVisible())) { await b.click({ timeout: 2000 }); await sleep(1200); } } catch {} }
          const count = await page.evaluate((q) => document.querySelectorAll(q).length, sel.ltitle);
          if (count === last) { if (++stable >= 3) break; } else { stable = 0; last = count; }
        }
        const items = await readCards(page); const n = await collect(items, url); total += n;
        if (DEBUG) {
          console.log(`    ${items.length} cards, ${n} new`);
          if (!items.length && !QUIET) { const info = await page.evaluate(({ lt, lp }) => ({ title: document.title, url: location.href, titleEls: document.querySelectorAll(lt).length, priceEls: document.querySelectorAll(lp).length, cardHtml: (() => { let e = document.querySelector(lp); for (let k = 0; k < 4 && e && e.parentElement; k++) e = e.parentElement; return e ? e.outerHTML.replace(/\s+/g, ' ').slice(0, 1200) : null; })() }), { lt: sel.ltitle, lp: sel.lprice }); console.log('    debug: ' + JSON.stringify(info)); try { await page.screenshot({ path: 'edge-debug.png' }); console.log('    screenshot: edge-debug.png'); } catch {} }
        }
      }
    } catch (e) { console.log(`  fail ${h(url)}: ${e.message.split('\n')[0]}`); }
    await sleep(cfg.delay_ms || 600);
  }
  return total;
}

(async () => {
  const cfg = await api('/config');
  const only = arg('--url', '');
  const useListing = !only && cfg.selectors && cfg.selectors.listing;
  console.log(`Source: ${QUIET ? '#' + (cfg.source_id ?? '?') : cfg.source + ' (' + cfg.client + ')'} — ${only ? 'single URL test' : useListing ? 'reading category listings' : 'reading sitemap…'}`);
  const manualKey = {}; for (const m of cfg.manual_urls || []) manualKey[m.url] = m.key;
  const urls = only ? [only] : useListing ? [] : [...(await sitemapUrls(cfg)).slice(0, LIMIT || undefined), ...Object.keys(manualKey)];
  if (!useListing) console.log(`${urls.length} product URLs`);
  const started = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36', locale: 'en-KW' });
  await ctx.route('**/*', (route) => (/\.(png|jpe?g|gif|webp|svg|woff2?|ttf|mp4)(\?|$)/i.test(route.request().url()) ? route.abort() : route.continue()));
  let i = 0, total = 0, batch = [], failed = []; // failed: hand-linked pages whose price could not be read (server flags them for automation)
  const flush = async (final = false) => {
    if (!batch.length && !final) return;
    let res;
    try { res = await api('/ingest', { method: 'POST', body: JSON.stringify({ products: batch, final, started, total, failed: final ? failed : undefined }) }); }
    catch (e) { if (final) throw e; console.log(`  ingest still failing, keeping ${batch.length} products for the next flush: ${e.message.slice(0, 120)}`); return; }
    total += res.upserted || 0; batch = [];
    if (final) console.log(`Done. ${total} products recorded; ${res.matched ?? 0} matched to the client's catalogue.`);
  };
  const worker = async () => {
    const page = await ctx.newPage();
    while (i < urls.length) {
      const url = urls[i++];
      try {
        const r = await extract(page, url, cfg); const price = num(r.price);
        if (DEBUG) { console.log(JSON.stringify(r)); try { await page.screenshot({ path: 'edge-debug.png', fullPage: false }); console.log('  screenshot: edge-debug.png'); } catch {} }
        if (r.title && price) { batch.push({ key: manualKey[url] || r.sku || url, title: r.title.replace(/\s+/g, ' ').slice(0, 300), price, brand: r.brand || undefined, sku: r.sku || undefined, available: r.available !== false, url, image: r.image || undefined }); }
        else { console.log(`  skip (no price) ${h(url)}`); if (manualKey[url]) failed.push({ key: manualKey[url], url, reason: 'no price read' }); }
      } catch (e) { console.log(`  fail ${h(url)}: ${e.message.split('\n')[0]}`); if (manualKey[url]) failed.push({ key: manualKey[url], url, reason: e.message.split('\n')[0].slice(0, 100) }); }
      if (batch.length >= 50) await flush();
      await sleep(cfg.delay_ms || 600);
      if (i % 25 === 0) console.log(`  ${i}/${urls.length}`);
    }
    await page.close();
  };
  if (useListing) {
    const page = await ctx.newPage();
    // flush every 50 products so progress is kept even if the run is cut short (CI time limits)
    await crawlListing(page, cfg, async (prod) => { batch.push(prod); if (batch.length >= 50) await flush(); });
    for (const m of cfg.manual_urls || []) { // competitor pages linked by hand in the app — refresh them individually
      try { const r = await extract(page, m.url, cfg); const price = num(r.price); if (r.title && price) batch.push({ key: m.key, title: r.title.replace(/\s+/g, ' ').slice(0, 300), price, available: r.available !== false, url: m.url }); else { console.log(`  manual link: no price read for ${m.url}`); failed.push({ key: m.key, url: m.url, reason: 'no price read' }); } }
      catch (e) { console.log(`  manual link fail ${h(m.url)}: ${e.message.split('\n')[0]}`); failed.push({ key: m.key, url: m.url, reason: e.message.split('\n')[0].slice(0, 100) }); }
      await sleep(cfg.delay_ms || 600);
    }
    await page.close();
  } else {
    await Promise.all(Array.from({ length: CONC }, worker));
  }
  await flush(true);
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
