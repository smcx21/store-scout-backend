const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');

// Read settings from backend/.env (see .env.example)
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch {}

const app  = express();
const PORT = process.env.PORT || 3000;
// Only this PC can reach the server unless HOST is changed (e.g. 0.0.0.0 when deploying)
const HOST = process.env.HOST || '127.0.0.1';
const SERPAPI_KEY    = process.env.SERPAPI_KEY;
const API_TOKEN      = process.env.API_TOKEN      || null;

const BARCODE_TYPES     = new Set(['gtin', 'gtin8', 'gtin12', 'gtin13', 'gtin14', 'upc', 'ean']);
// Extra paid searches to find direct product pages. Off by default: SerpAPI's web search
// is often too slow to be worth it, and store search pages work without it.
const MAX_LINK_LOOKUPS  = parseInt(process.env.MAX_LINK_LOOKUPS || '0', 10);
// Google product pages to open per search (each is one paid search). They add more
// stores and give direct product links; 0 turns them off.
// Off by default: in Australia most product pages only list one store, so it's cheaper to
// fetch a store's direct link when it's clicked (/api/link) than for every store upfront.
const MAX_PRODUCT_PAGES = parseInt(process.env.MAX_PRODUCT_PAGES || '0', 10);
const TOO_EXPENSIVE_RATIO = 1.35; // hide listings over 1.35× the normal price (resale sites run ~1.1–1.3×)
const TOO_CHEAP_RATIO     = 0.6; // flag unknown stores under 0.6× the normal price
const CACHE_TTL_MS      = 12 * 60 * 60 * 1000;
const CACHE_FILE        = process.env.CACHE_FILE || path.join(__dirname, 'cache.json');
const AMAZON_TAG     = process.env.AMAZON_TAG     || null;
const SHAREASALE_ID  = process.env.SHAREASALE_ID  || null;
const CJ_ID          = process.env.CJ_ID          || null;
const RAKUTEN_ID     = process.env.RAKUTEN_ID      || null;

const VERIFIED_STORES = new Set([
  'nike', 'adidas', 'foot locker', 'footlocker', 'jd sports', 'asos',
  'the iconic', 'platypus', 'hype dc', 'rebel sport', 'culture kings',
  'stylerunner', 'glue store', 'amazon', 'myer', 'david jones',
  'converse', 'vans', 'puma', 'reebok', 'new balance', 'asics',
  'hoka', 'under armour', 'goat', 'stockx',
]);

const BLOCKED_STORES = [
  'ebay', 'wish', 'aliexpress', 'temu', 'shein', 'romwe',
  'cash converters', 'cashaway', 'custompaperclips', 'wormtokyo',
  'unisuperb', 'n-hype', 'nhype', 'vinted', 'depop', 'gumtree',
  'modesens', 'fashionnova', 'fashion nova', 'boohoo', 'boohooman',
  'jo malone', 'shaver shop', 'qantas', 'east essence',
  'bronze snake', 'crushprints', 'omegawalk',
  "what's your size", 'geturbrick', 'reversible',
];

app.use(cors());
app.use(express.json());

// ── Health check ──────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', serpapi: !!SERPAPI_KEY });
});

// ── Optional shared token ─────────────────────────────────────────────
// If API_TOKEN is set, the extension must send the same value (Settings page).
app.use('/api', (req, res, next) => {
  if (API_TOKEN && req.get('x-storescout-token') !== API_TOKEN) {
    return res.status(401).json({ error: 'Bad or missing token', deals: [] });
  }
  next();
});

// ── Search ────────────────────────────────────────────────────────────
app.post('/api/search', async (req, res) => {
  const { identifier, identifierType, title, brand, currentPrice, currency: sourceCurrency, size, gender, color } = req.body;
  // Older extension versions only send `identifier`, so fall back to it
  const styleCode = req.body.styleCode || (identifierType === 'sku' ? identifier : null);
  const barcode   = normalizeBarcode(req.body.barcode || (BARCODE_TYPES.has(identifierType) ? identifier : null));

  if (!SERPAPI_KEY) {
    return res.status(500).json({ error: 'SERPAPI_KEY not set — add it to backend/.env', deals: [] });
  }

  const query = buildQuery(brand, title, identifier, identifierType, gender, color);
  if (!query.trim()) {
    return res.json({ deals: [] });
  }

  // Same product + size + gender → reuse the earlier answer instead of paying for new searches
  const cacheKey = [styleCode || barcode || query, color, size, gender].join('|').toLowerCase();
  const cached = getCached(cacheKey);
  if (cached) {
    console.log(`[StoreScout] Cache hit: ${cacheKey}`);
    return res.json(withCurrentPrice(cached, currentPrice, sourceCurrency));
  }

  // The same product asked for twice at once (e.g. the popup reopened) shares one search
  if (inFlight.has(cacheKey)) console.log(`[StoreScout] Joining search already running: ${cacheKey}`);
  else inFlight.set(cacheKey, runSearch().finally(() => inFlight.delete(cacheKey)));

  try {
    const payload = await inFlight.get(cacheKey);
    res.json(withCurrentPrice(payload, currentPrice, sourceCurrency));
  } catch (err) {
    console.error('[StoreScout] SerpAPI error:', err.message);
    res.status(502).json({ error: err.message, deals: [] });
  }

  async function runSearch() {
    const fxPromise = fetchAUDRates();
    let searchesUsed = 0;
    const shop = q => { searchesUsed++; return shoppingSearch(q); };

    const product = { title, brand, color, styleCode };
    const keep = r => containsStyleCode(r.title, styleCode) || mentionsProduct(r.title, title, brand, 0.5);
    const countExact = rs => rs.filter(r => matchLevel(r.title, product) !== 'similar').length;

    // Style code (exact model + colourway), else barcode, pins down the exact product;
    // name + colour finds the rest. Both run at once — SerpAPI can take 20s per search.
    // Google can mix in unrelated items, so every result must also name the product.
    const exactQuery = styleCode ? `${brand || ''} ${styleCode}`.trim() : barcode;
    const [exactRaw, titleRaw] = await Promise.all([
      exactQuery ? shop(exactQuery) : [],
      shop(query),
    ]);
    const exactResults = filterResults(exactRaw, gender).filter(keep);
    const titleResults = filterResults(titleRaw, gender).filter(keep);
    if (exactQuery) console.log(`[StoreScout] Exact query "${exactQuery}" → ${exactResults.length} usable, ${countExact(exactResults)} exact`);
    console.log(`[StoreScout] Title query "${query}" → ${titleResults.length} usable, ${countExact(titleResults)} exact`);
    const results = exactResults.concat(titleResults);

    // Open Google's product page for the best few matches: it lists every store selling
    // that product, each with a direct link to the store's own product page.
    const pages = pickProductPages(results, product, MAX_PRODUCT_PAGES);
    searchesUsed += pages.length;
    const storeOffers = (await Promise.all(pages.map(productPageOffers)))
      .flat()
      .filter(r => filterResults([r], gender).length && keep(r));
    console.log(`[StoreScout] ${pages.length} product pages → ${storeOffers.length} store offers`);

    const fxRates = await fxPromise;

    let deals = cheapestPerStore(storeOffers.concat(results).map(item => toDeal(item, title, size, fxRates, product)));

    // Only look up direct product pages for the cheapest few stores without one —
    // each lookup is another paid search. A store's address must be known (not guessed)
    // or the search finds nothing. The rest link to the store's own search page.
    const needLinks = deals
      .filter(d => !d.hasDirectUrl && knownDomain(d.storeName))
      .sort((a, b) => a.total - b.total)
      .slice(0, MAX_LINK_LOOKUPS);
    const linkQuery = exactQuery && styleCode ? exactQuery : query;
    searchesUsed += needLinks.length;
    const directUrlsByDomain = await fetchPerStoreDirectUrls(linkQuery, needLinks.map(d => d.storeName), SERPAPI_KEY, size);

    deals = deals.map(d => {
      const directUrl = d.hasDirectUrl ? d.url : directUrlsByDomain[getStoreDomain(d.storeName)];
      // Unknown stores: Google's page for this exact offer beats a guessed store search
      const url = directUrl
        || (knownDomain(d.storeName) ? storeSearchUrl(d.storeName, query) : d.googleUrl)
        || storeSearchUrl(d.storeName, query);
      const deal = { ...d, url, hasDirectUrl: !!directUrl };
      return { ...deal, affiliateUrl: applyAffiliateTag(url, d.storeName), ...easeScore(deal) };
    });

    const payload = { deals, fxRates, searchesUsed };
    setCached(cacheKey, payload);
    console.log(`[StoreScout] ${deals.length} deals, ${searchesUsed} SerpAPI searches used`);
    return payload;
  }
});

const inFlight = new Map();

// ── Direct link for one listing (fetched when the user clicks it) ─────
app.post('/api/link', async (req, res) => {
  const { token, storeName } = req.body || {};
  if (!token) return res.status(400).json({ error: 'Missing token' });
  if (!SERPAPI_KEY) return res.status(500).json({ error: 'SERPAPI_KEY not set' });

  const key = `link|${token}|${storeName}`.toLowerCase();
  const cached = getCached(key);
  if (cached) return res.json(cached);

  const offers = await productPageOffers({ immersive_product_page_token: token });
  const name = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const offer = offers.find(o => name(o.source) === name(storeName))
    || offers.find(o => name(o.source).includes(name(storeName)) || name(storeName).includes(name(o.source)));
  const url = offer && isMerchantUrl(offer.link) ? offer.link : null;
  console.log(`[StoreScout] Link for ${storeName}: ${url || 'not found'} (${offers.length} stores on page)`);

  const payload = { url: url ? applyAffiliateTag(url, storeName) : null };
  if (url) setCached(key, payload);
  res.json(payload);
});

async function shoppingSearch(q) {
  const params = new URLSearchParams({
    engine:   'google_shopping',
    q,
    api_key:  SERPAPI_KEY,
    num:      '20',
    gl:       'au',
    hl:       'en',
    location: 'Australia',
  });
  const serpRes  = await fetch(`https://serpapi.com/search.json?${params}`, { signal: AbortSignal.timeout(60000) });
  const serpData = await serpRes.json();
  if (serpData.error) {
    // "no results" is a normal answer, not a failure
    if (/hasn't returned any results/i.test(serpData.error)) return [];
    console.error('[StoreScout] SerpAPI returned error:', serpData.error);
    throw new Error(serpData.error);
  }
  return serpData.shopping_results || [];
}

// The matching results worth opening Google's product page for: exact before likely,
// big trusted stores first (their product pages list the most other stores), one per product
function pickProductPages(results, product, max) {
  const rank = { exact: 0, likely: 1 };
  const seen = new Set();
  return results
    .map((r, i) => ({ r, i, level: matchLevel(r.title, product) }))
    .filter(x => x.r.immersive_product_page_token && x.level !== 'similar')
    .sort((a, b) => rank[a.level] - rank[b.level]
      || isVerified(b.r.source) - isVerified(a.r.source)
      || a.i - b.i)
    .filter(x => {
      const id = x.r.product_id || x.r.title;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .slice(0, max)
    .map(x => x.r);
}

// Every store on Google's product page, shaped like a shopping result
async function productPageOffers(result) {
  const params = new URLSearchParams({
    engine:     'google_immersive_product',
    page_token: result.immersive_product_page_token,
    api_key:    SERPAPI_KEY,
    gl:         'au',
    hl:         'en',
  });
  try {
    const res  = await fetch(`https://serpapi.com/search.json?${params}`, { signal: AbortSignal.timeout(60000) });
    const data = await res.json();
    if (data.error) {
      if (!/hasn't returned any results/i.test(data.error)) console.log(`[StoreScout] Product page error: ${data.error}`);
      return [];
    }
    return (data.product_results?.stores || []).map(s => ({
      source:          s.name,
      title:           s.title || data.product_results.title || result.title,
      price:           s.price,
      extracted_price: s.extracted_price,
      link:            s.link,
      delivery:        /free/i.test(s.shipping || '') ? 'Free delivery' : (s.shipping ? `${s.shipping} delivery` : null),
      rating:          s.rating,
      reviews:         s.reviews,
      thumbnail:       result.thumbnail,
      product_link:    result.product_link,
    }));
  } catch (err) {
    // One slow product page shouldn't sink the whole search
    console.log(`[StoreScout] Product page failed: ${err.message}`);
    return [];
  }
}

// Product pages often pad barcodes to 14 digits ("00198966169739"), which Google
// doesn't recognise. Strip the padding back to the 12-digit UPC / 13-digit EAN.
function normalizeBarcode(raw) {
  let code = String(raw || '').replace(/\D/g, '');
  while (code.length > 12 && code.startsWith('0')) code = code.slice(1);
  return code.length >= 8 && code.length <= 14 ? code : null;
}

const GENERIC_WORDS = new Set([
  'the', 'and', 'for', 'with', 'shoe', 'shoes', 'sneaker', 'sneakers', 'trainer', 'trainers',
  'men', 'mens', 'women', 'womens', 'kids', 'unisex', 'running', 'basketball', 'lifestyle',
  'size', 'pair', 'new', 'sale', 'black', 'white',
]);

// Does a result look like the same product? It must name the brand (if known) and share
// at least `minShare` of the product name's distinctive words — model numbers count,
// so "Sabrina 4 Nationals" matches "Sabrina 4 'Count Ionescu'" but "Air Max 270"
// doesn't match "Air Force 1 '07 Patent Leather".
function mentionsProduct(resultTitle, originalTitle, brand, minShare = 0.5) {
  if (!resultTitle || !originalTitle) return true;
  const words = s => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  const result = new Set(words(resultTitle));
  const brandWords = brand ? words(brand) : [];
  if (brandWords.length && !brandWords.every(w => result.has(w))) return false;
  const distinctive = [...new Set(words(originalTitle))]
    .filter(w => (/^\d+$/.test(w) || w.length >= 3) && !GENERIC_WORDS.has(w) && !brandWords.includes(w));
  if (distinctive.length === 0) return true;
  // Model numbers must all be there ("Sabrina 4" isn't "Sabrina 3"). Digits are read out of
  // any word, so "AF1" still counts as having the "1".
  const resultNumbers = new Set((resultTitle.match(/\d+/g) || []).map(n => n.replace(/^0+(?=\d)/, '')));
  const ourNumbers = distinctive.filter(w => /^\d+$/.test(w)).map(n => n.replace(/^0+(?=\d)/, ''));
  if (!ourNumbers.every(n => resultNumbers.has(n))) return false;
  const matched = distinctive.filter(w => result.has(w) || (/^\d+$/.test(w))).length;
  return matched / distinctive.length >= minShare;
}

function filterResults(results, gender) {
  return results
    .filter(r => r.source && (r.extracted_price || parsePrice(r.price)) > 0)
    .filter(r => !BLOCKED_STORES.some(b => r.source.toLowerCase().includes(b)))
    .filter(r => !isWrongGender(r.title, gender));
}

// "IX7058-001" also matches "ix7058 001" or "IX7058001" in a store's title
function containsStyleCode(resultTitle, styleCode) {
  if (!resultTitle || !styleCode) return false;
  const squash = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  return squash(resultTitle).includes(squash(styleCode));
}

const COLOUR_WORDS = new Set([
  'black', 'white', 'grey', 'gray', 'red', 'blue', 'green', 'yellow', 'orange', 'pink',
  'purple', 'brown', 'beige', 'cream', 'navy', 'silver', 'gold', 'tan', 'bone', 'sail',
  'volt', 'anthracite', 'olive', 'burgundy', 'teal', 'khaki', 'ivory', 'multi', 'multicolour',
]);
// Words that mean a different version of the same shoe (if the original doesn't have them)
const VARIANT_WORDS = new Set([
  'premium', 'prm', 'lx', 'lv8', 'se', 'mid', 'high', 'retro', 'og', 'sp', 'qs', 'plus',
  'utility', 'gtx', 'goretex', 'shadow', 'flyknit', 'react', 'next', 'craft', 'crater', 'jewel',
  'edge', 'platform', 'pltform', 'luxe', 'fontanka', 'wb', 'vintage',
  'gs', 'ps', 'td',   // kids' sizes (grade school, pre-school, toddler)
]);

// 'exact'   = same model and colourway (style code in the title, or name + colour match)
// 'likely'  = same model, but the listing doesn't say the colour
// 'similar' = same shoe line, but a different colour/version
function matchLevel(resultTitle, { title, brand, color, styleCode }) {
  if (containsStyleCode(resultTitle, styleCode)) return 'exact';
  const words = s => new Set(String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean));
  const result = words(resultTitle);
  const original = words(title);

  if ([...result].some(w => VARIANT_WORDS.has(w) && !original.has(w))) return 'similar';
  // Without a style code, every distinctive word of the name must be there
  if (!mentionsProduct(resultTitle, title, brand, 1)) return 'similar';

  // Colour: naming a colour we don't have means a different colourway.
  // Listings (or pages) that don't state a colour can't be confirmed either way.
  const ours   = new Set([...words(color), ...[...original].filter(w => COLOUR_WORDS.has(w))]);
  const theirs = [...result].filter(w => COLOUR_WORDS.has(w));
  if (theirs.some(w => !ours.has(w))) return 'similar';
  if (!ours.size || !theirs.length) return 'likely';
  return 'exact';
}

function toDeal(item, title, size, fxRates, product) {
  const store     = item.source || '';
  const extras    = [item.delivery, ...(item.extensions || [])].filter(Boolean).join(' ');
  const freeShip  = /free (delivery|shipping)/i.test(extras);
  const shipping  = freeShip ? 0 : extractShippingCost(item.delivery);
  const rawPrice  = item.extracted_price || parsePrice(item.price);
  const currency  = detectCurrency(item.price, store);
  const price     = convertToAUD(rawPrice, currency, fxRates);
  const merchantUrl = isMerchantUrl(item.link) ? item.link : null;
  return {
    storeName:     store,
    title:         item.title || title,
    matchLevel:    product ? matchLevel(item.title, product) : 'similar',
    price,
    shipping,
    shippingKnown: shipping != null,
    freeShipping:  freeShip,
    total:         Math.round((price + (shipping || 0)) * 100) / 100,
    delivery:      item.delivery || null,
    currency,
    salePercent:   extractSalePercent(item.extensions || []),
    verified:      isVerified(store),
    rating:        item.rating || null,
    reviews:       item.reviews || null,
    url:           merchantUrl,
    hasDirectUrl:  !!merchantUrl,
    googleUrl:     item.product_link || null,
    // Lets the popup fetch this listing's direct store link when it's clicked
    linkToken:     merchantUrl ? null : (item.immersive_product_page_token || null),
    image:         item.thumbnail || null,
    sameSize:      matchesSize(item.title, size),
    priceVaries:   isResalePlatform(getStoreDomain(store)),
  };
}

// Google often lists one store several times — keep its best match, preferring an offer
// with a direct product link, then the cheapest
const MATCH_RANK = { exact: 0, likely: 1, similar: 2 };
function cheapestPerStore(deals) {
  const best = new Map();
  const better = (a, b) =>
    a.matchLevel !== b.matchLevel ? MATCH_RANK[a.matchLevel] < MATCH_RANK[b.matchLevel]
    : a.hasDirectUrl !== b.hasDirectUrl ? a.hasDirectUrl
    : a.total < b.total;
  for (const d of deals) {
    const key = d.storeName.toLowerCase();
    if (!best.has(key) || better(d, best.get(key))) best.set(key, d);
  }
  return [...best.values()];
}

// "Easiest" = least hassle buying from this store. Lower score is better.
// The score is the total price inflated by a percentage for each hassle,
// so a slightly dearer trusted store with free shipping can beat a cheap risky one.
function easeScore(deal) {
  const hassles = [];
  if (!deal.verified)                 hassles.push(['Less-known store', 0.15]);
  if (deal.priceVaries)               hassles.push(['Resale marketplace', 0.10]);
  if (deal.currency !== 'AUD')        hassles.push(['Ships from overseas', 0.10]);
  if (!deal.shippingKnown)            hassles.push(['Shipping cost unknown', 0.05]);
  if (!deal.hasDirectUrl)             hassles.push(['Opens a store search', 0.05]);
  const penalty = hassles.reduce((sum, [, p]) => sum + p, 0);
  return {
    easeScore: Math.round(deal.total * (1 + penalty) * 100) / 100,
    hassles:   hassles.map(([label]) => label),
  };
}

// Prices are compared per request, since the cached deals are shared across pages
function withCurrentPrice(payload, currentPrice, sourceCurrency) {
  const current = parseFloat(currentPrice);
  const currentAUD = current > 0
    ? convertToAUD(current, (sourceCurrency || 'AUD').toUpperCase(), payload.fxRates || {})
    : null;
  const ref = referencePrice(payload.deals, currentAUD);

  const deals = payload.deals
    .map(d => ({
      ...d,
      saving: currentAUD ? Math.round((currentAUD - d.total) * 100) / 100 : null,
      // Unknown stores far below the normal price are a classic sign of fakes/scams
      tooCheap: !!ref && !d.verified && d.total < ref * TOO_CHEAP_RATIO,
    }))
    // Far above the normal price = a different edition, a huge size, or reseller markup
    .filter(d => !ref || d.total <= ref * TOO_EXPENSIVE_RATIO);

  const hiddenExpensive = payload.deals.length - deals.length;
  if (hiddenExpensive) console.log(`[StoreScout] Hid ${hiddenExpensive} listings over ${TOO_EXPENSIVE_RATIO}× $${ref}`);
  return { deals, currentPriceAUD: currentAUD, referencePrice: ref, hiddenExpensive, searchesUsed: payload.searchesUsed };
}

// The "normal" price to judge others against: this page's price if we know it,
// otherwise the middle price of the exact matches (or of everything, if none are exact)
function referencePrice(deals, currentAUD) {
  if (currentAUD) return currentAUD;
  const exact = deals.filter(d => d.matchLevel !== 'similar');
  const totals = (exact.length ? exact : deals).map(d => d.total).filter(t => t > 0).sort((a, b) => a - b);
  if (!totals.length) return null;
  const mid = Math.floor(totals.length / 2);
  return totals.length % 2 ? totals[mid] : (totals[mid - 1] + totals[mid]) / 2;
}

// ── Cache (saved to disk so restarts don't cost searches) ─────────────
const cache = loadCache();

function loadCache() {
  try {
    return new Map(Object.entries(JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'))));
  } catch {
    return new Map();
  }
}
function getCached(key) {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > CACHE_TTL_MS) { cache.delete(key); return null; }
  return e.data;
}
function setCached(key, data) {
  cache.set(key, { data, ts: Date.now() });
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(Object.fromEntries(cache))); } catch {}
}

// ── Helpers ───────────────────────────────────────────────────────────
const STORE_DOMAINS = {
  // Australian stores
  'foot locker': 'footlocker.com.au', 'footlocker': 'footlocker.com.au',
  'jd sports': 'jdsports.com.au',
  'the iconic': 'theiconic.com.au',
  'platypus': 'platypus.com.au',
  'hype dc': 'hypedc.com',
  'rebel sport': 'rebelsport.com.au', 'rebel': 'rebelsport.com.au',
  'culture kings': 'culturekings.com.au',
  'stylerunner': 'stylerunner.com',
  'glue store': 'gluestore.com.au',
  'myer': 'myer.com.au',
  'david jones': 'davidjones.com',
  'amazon': 'amazon.com.au',
  'asos': 'asos.com',
  // Global brands with AU sites
  'nike': 'nike.com', 'adidas': 'adidas.com.au',
  'new balance': 'newbalance.com.au', 'reebok': 'reebok.com',
  'puma': 'au.puma.com', 'under armour': 'underarmour.com',
  'converse': 'converse.com.au', 'vans': 'vans.com.au',
  'skechers': 'skechers.com.au', 'asics': 'asics.com/au',
  'hoka': 'hoka.com', 'on running': 'on-running.com',
  // Resale / global shipping to AU
  'goat': 'goat.com', 'stockx': 'stockx.com',
  'flight club': 'flightclub.com', 'lyst': 'lyst.com',
  'novelship': 'novelship.com', 'kickscrew': 'kickscrew.com',
  'farfetch': 'farfetch.com', 'sneaker hut': 'sneakerhut.com.au',
  'shoegrab': 'shoegrab.com.au', 'courtside': 'courtsidemelbourne.com',
  'incu': 'incu.com', 'up there': 'upthere.com.au',
  'less 17': 'less17.com.au', 'cettire': 'cettire.com',
  'ssense': 'ssense.com', 'pushas': 'pushas.com',
  'limitededt': 'limitededt.com', 'limited edt': 'limitededt.com',
  'the mint company': 'themintcompany.com', 'mint company': 'themintcompany.com',
  'cruizeer': 'cruizeer.com', 'coproom': 'coproom.com.au',
  'mr porter': 'mrporter.com', 'mrporter': 'mrporter.com',
  'highs and lows': 'highsandlows.com', 'motion lifestyle': 'motionlifestyle.com.au',
  'usg store': 'usgstore.com.au', 'prime athletic': 'primeathletic.com.au',
  'revolve': 'revolve.com', 'solebox': 'solebox.com',
  'laced': 'laced.com', 'sevenstore': 'sevenstore.com',
  'afew': 'afew-store.com', 'above the clouds': 'abovetheclouds.com',
  'sisters': 'sistersandco.com.au',
};

function getStoreDomain(storeName) {
  return knownDomain(storeName) || (storeName || '').toLowerCase().replace(/[^a-z0-9]/g, '') + '.com';
}

// The store's real web address, or null if we'd only be guessing
function knownDomain(storeName) {
  const s = (storeName || '').toLowerCase().trim();
  for (const [key, domain] of Object.entries(STORE_DOMAINS)) {
    if (s.includes(key)) return domain;
  }
  // Google sometimes names the store by its address, e.g. "santkicks.com"
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(s)) return s.replace(/^www\./, '');
  return null;
}

const RESALE_PLATFORMS = ['goat.com', 'stockx.com', 'flightclub.com', 'novelship.com', 'kickscrew.com'];

function isResalePlatform(domain) {
  return RESALE_PLATFORMS.some(p => domain.includes(p));
}

function appendSizeToUrl(url, size, domain) {
  if (!size || !url) return url;
  try {
    const u = new URL(url);
    if (domain.includes('goat.com') || domain.includes('stockx.com') ||
        domain.includes('flightclub.com') || domain.includes('novelship.com')) {
      u.searchParams.set('size', size);
      return u.toString();
    }
  } catch {}
  return url;
}

async function fetchPerStoreDirectUrls(query, storeNames, apiKey, size) {
  const urlsByDomain = {};
  await Promise.all(storeNames.map(async (storeName) => {
    const domain = getStoreDomain(storeName);
    if (!domain) return;
    try {
      // For resale platforms, include size in the search query for accurate pricing
      const sizeClause = size && isResalePlatform(domain) ? ` US${size}` : '';
      const params = new URLSearchParams({
        engine:  'google',
        q:       `${query}${sizeClause} site:${domain}`,
        api_key: apiKey,
        num:     '3',
        gl:      'au',
        hl:      'en',
      });
      const res  = await fetch(`https://serpapi.com/search.json?${params}`, {
        // SerpAPI's web search often takes 5–10s; giving up sooner still costs the search
        signal: AbortSignal.timeout(12000),
      });
      const data = await res.json();
      const hit  = (data.organic_results || []).find(r => {
        try { return new URL(r.link).hostname.includes(domain.replace('www.', '')); } catch { return false; }
      });
      if (hit?.link && urlMatchesProduct(hit.link)) {
        const finalUrl = appendSizeToUrl(hit.link, size, domain);
        urlsByDomain[domain] = finalUrl;
        console.log(`[StoreScout] Direct: ${storeName} → ${finalUrl}`);
      } else if (hit?.link) {
        console.log(`[StoreScout] Rejected URL (wrong product): ${storeName} → ${hit.link}`);
      }
    } catch (err) {
      console.log(`[StoreScout] Site search failed for ${storeName}: ${err.message}`);
    }
  }));
  return urlsByDomain;
}

function buildQuery(brand, title, identifier, identifierType, gender, color) {
  // Always prefer the human-readable title — SKUs like "IH1698-100" don't search well
  let q = title || '';
  const original = q;

  // Only strip numbers that are clearly sizes — require explicit size context
  // e.g. "Size 10", "US 10.5", "UK 9", "EU 44", "10 Men's" — NOT "Pegasus 41" or "Air Max 270"
  // ("10 Men's" isn't stripped: it can't be told apart from model names like "Air Force 1 '07 Men's")
  q = q.replace(/\b(size\s*|US\s*|UK\s*|EU\s*)\d{1,3}(\.\d)?\b/gi, '');
  // Strip gendered descriptors
  q = q.replace(/\b(men'?s?|women'?s?|kids?'?s?|youth|unisex|toddler|infant|adult)\b/gi, '');
  // Strip generic footwear words that add no model identity
  q = q.replace(/\b(running shoe|shoe|sneaker|trainer|boot|sandal|slipper)s?\b/gi, '');
  // Keep colorway — "White/Black" makes the search specific to that exact shoe
  // Only clean up punctuation and extra whitespace
  q = q.replace(/[()'"]+/g, '').replace(/\s+/g, ' ').trim();

  // Safety net: if cleaning left too little, use the original title
  if (q.length < 6) q = original.slice(0, 80).trim();

  // Prepend brand if not already in the cleaned title
  if (brand && !q.toLowerCase().includes(brand.toLowerCase())) {
    q = `${brand} ${q}`;
  }

  // Append colorway — strip slashes so "White/White" becomes "White"
  if (color) {
    const cleanColor = color.split('/')[0].trim();
    if (cleanColor && !q.toLowerCase().includes(cleanColor.toLowerCase())) {
      q += ` ${cleanColor}`;
    }
  }

  // Append gender to steer results toward the right category
  if (gender === 'women') q += " women's";
  else if (gender === 'men') q += " men's";
  else if (gender === 'kids') q += ' kids';

  console.log(`[StoreScout] Built query: "${q}" (from title: "${(title || '').slice(0, 50)}")`);
  return q.slice(0, 100).trim();
}

function applyAffiliateTag(url, storeName) {
  if (!url) return url;
  try {
    const u   = new URL(url);
    const host = u.hostname.toLowerCase();
    const s    = (storeName || '').toLowerCase();

    if (host.includes('amazon.') && AMAZON_TAG) {
      u.searchParams.set('tag', AMAZON_TAG);
      return u.toString();
    }
    if (SHAREASALE_ID && (s.includes('culture kings') || s.includes('hype dc') || s.includes('stylerunner') || s.includes('glue store'))) {
      return `https://www.shareasale.com/r.cfm?u=${SHAREASALE_ID}&urllink=${encodeURIComponent(url)}`;
    }
    if (CJ_ID && (s.includes('foot locker') || s.includes('nike') || s.includes('adidas') || s.includes('converse') || s.includes('vans'))) {
      return `https://www.anrdoezrs.net/click-${CJ_ID}?url=${encodeURIComponent(url)}`;
    }
    if (RAKUTEN_ID && (s.includes('reebok') || s.includes('puma') || s.includes('new balance') || s.includes('asics'))) {
      return `https://click.linksynergy.com/deeplink?id=${RAKUTEN_ID}&murl=${encodeURIComponent(url)}`;
    }
  } catch {}
  return url;
}

async function fetchAUDRates() {
  try {
    const res  = await fetch('https://api.frankfurter.app/latest?to=AUD', {
      signal: AbortSignal.timeout(3000),
    });
    const data = await res.json();
    // data.rates = { USD: 1.53, GBP: 1.95, EUR: 1.65, ... } meaning X foreign = Y AUD
    return data.rates || {};
  } catch {
    return { USD: 1.55, GBP: 1.95, EUR: 1.65, JPY: 0.0105 }; // fallback
  }
}

function detectCurrency(priceStr, storeName) {
  if (!priceStr) return 'AUD';
  const p = priceStr.toUpperCase();
  if (p.includes('US$') || p.includes('USD'))         return 'USD';
  if (p.includes('£')   || p.includes('GBP'))         return 'GBP';
  if (p.includes('€')   || p.includes('EUR'))         return 'EUR';
  if (p.includes('AU$') || p.includes('A$') || p.includes('AUD')) return 'AUD';
  // US resale platforms price in USD even on AU
  const usPlatforms = ['goat', 'stockx', 'flight club', 'stadium goods', 'kickscrew', 'novelship'];
  if (usPlatforms.some(s => (storeName || '').toLowerCase().includes(s))) return 'USD';
  return 'AUD';
}

function convertToAUD(price, currency, rates) {
  if (!price || currency === 'AUD') return price;
  const rate = rates[currency];
  if (!rate) return price;
  return Math.round(price * rate * 100) / 100;
}

function urlMatchesProduct(url) {
  if (!url) return false;
  const u = url.toLowerCase();
  // Reject URLs that are clearly category, search, or collection pages
  const badPatterns = [
    '/search?', '/collections/', '/category/', '/categories/', '/catalog/',
    '?q=', '?query=', 'searchterm=', 'searchtext=', 'keyword=', '_nkw=',
    '/au/w/', '/en-us/w/', '/en-gb/w/', '/en-au/w/',
    '/sale/', '/new-arrivals/', '/brands/', '/browse?',
    '/en/category', '/shop?', 'page=2', 'page=3',
    '/silhouette/', '/gender/', '/collections?',
  ];
  return !badPatterns.some(p => u.includes(p));
}


function matchesSize(resultTitle, size) {
  if (!size || !resultTitle) return false;
  const s = String(parseFloat(size));
  return new RegExp(`\\b${s.replace('.', '\\.')}\\b`).test(resultTitle);
}

function isWrongGender(resultTitle, gender) {
  if (!gender || !resultTitle) return false;
  const t = resultTitle.toLowerCase();
  const hasWomens = /\bwomen'?s?\b/.test(t);
  const hasMens   = /\bmen'?s?\b/.test(t) && !hasWomens;
  const hasKids   = /\b(kids?'?s?|youth|toddler|infant|children)\b/.test(t);
  if (gender === 'men')   return hasWomens || hasKids;
  if (gender === 'women') return hasMens   || hasKids;
  if (gender === 'kids')  return hasWomens || hasMens;
  return false;
}

function parsePrice(str) {
  if (!str) return null;
  const n = parseFloat(String(str).replace(/[^0-9.]/g, ''));
  return isNaN(n) ? null : n;
}

function extractShippingCost(delivery) {
  if (!delivery) return null;
  const m = delivery.match(/\$([0-9.]+)/);
  return m ? parseFloat(m[1]) : null;
}

function extractSalePercent(extensions) {
  for (const ext of extensions) {
    const m = String(ext).match(/(\d+)%\s*off/i);
    if (m) return parseInt(m[1]);
  }
  return 0;
}

// Google names stores like "Foot Locker AU" or "Nike.com", so match on the name inside
function isVerified(storeName) {
  const s = (storeName || '').toLowerCase();
  return [...VERIFIED_STORES].some(v => s.includes(v));
}

// SerpAPI's link is only useful if it's a real merchant product page, not a Google page
function isMerchantUrl(link) {
  return !!link && link.startsWith('https://') && !link.includes('google.') && urlMatchesProduct(link);
}

function storeSearchUrl(storeName, query) {
  const s = (storeName || '').toLowerCase();
  const q = encodeURIComponent(query);

  // Australian stores
  if (s.includes('foot locker') || s.includes('footlocker')) return `https://www.footlocker.com.au/search?query=${q}`;
  if (s.includes('jd sports'))                                return `https://www.jdsports.com.au/search/?searchText=${q}`;
  if (s.includes('the iconic'))                               return `https://www.theiconic.com.au/search/?q=${q}`;
  if (s.includes('platypus'))                                 return `https://www.platypus.com.au/search?q=${q}`;
  if (s.includes('hype dc'))                                  return `https://www.hypedc.com/search?type=product&q=${q}`;
  if (s.includes('rebel sport') || s.includes('rebel'))       return `https://www.rebelsport.com.au/search/?query=${q}`;
  if (s.includes('culture kings'))                            return `https://www.culturekings.com.au/search?q=${q}`;
  if (s.includes('stylerunner'))                              return `https://www.stylerunner.com/search?q=${q}`;
  if (s.includes('glue store'))                               return `https://www.gluestore.com.au/search?q=${q}`;
  if (s.includes('myer'))                                     return `https://www.myer.com.au/search?query=${q}`;
  if (s.includes('david jones'))                              return `https://www.davidjones.com/search?q=${q}`;
  if (s.includes('amazon'))                                   return `https://www.amazon.com.au/s?k=${q}`;
  if (s.includes('asos'))                                     return `https://www.asos.com/au/search?q=${q}`;

  // Global brands — AU pages
  if (s.includes('nike'))                                     return `https://www.nike.com/au/search?q=${q}`;
  if (s.includes('adidas'))                                   return `https://www.adidas.com.au/search?q=${q}`;
  if (s.includes('new balance'))                              return `https://www.newbalance.com.au/search/?q=${q}`;
  if (s.includes('converse'))                                 return `https://www.converse.com.au/search?q=${q}`;
  if (s.includes('vans'))                                     return `https://www.vans.com.au/search?q=${q}`;
  if (s.includes('skechers'))                                 return `https://www.skechers.com.au/en/search?q=${q}`;
  if (s.includes('puma'))                                     return `https://au.puma.com/au/en/search?q=${q}`;
  if (s.includes('under armour'))                             return `https://www.underarmour.com/en-au/search?q=${q}`;
  if (s.includes('asics'))                                    return `https://www.asics.com/au/en-au/search?q=${q}`;
  if (s.includes('hoka'))                                     return `https://www.hoka.com/en-au/search?q=${q}`;
  if (s.includes('reebok'))                                   return `https://www.reebok.com/en-au/search?q=${q}`;
  if (s.includes('on running') || s.includes('on cloud'))     return `https://www.on-running.com/en-au/search?q=${q}`;

  // Resale / global shipping to AU
  if (s.includes('goat'))                                     return `https://www.goat.com/search?query=${q}`;
  if (s.includes('stockx'))                                   return `https://stockx.com/search?s=${q}`;
  if (s.includes('flight club'))                              return `https://www.flightclub.com/search?q=${q}`;
  if (s.includes('lyst'))                                     return `https://www.lyst.com/search/?q=${q}`;
  if (s.includes('novelship'))                                return `https://novelship.com/browse?q=${q}`;
  if (s.includes('kickscrew'))                                return `https://www.kickscrew.com/search?q=${q}`;
  if (s.includes('farfetch'))                                 return `https://www.farfetch.com/au/shopping/search?q=${q}`;
  if (s.includes('sneaker hut'))                              return `https://www.sneakerhut.com.au/search?type=product&q=${q}`;
  if (s.includes('shoegrab'))                                 return `https://www.shoegrab.com.au/search?q=${q}`;
  if (s.includes('courtside'))                                return `https://www.courtsidemelbourne.com/search?q=${q}`;
  if (s.includes('incu'))                                     return `https://www.incu.com/search?q=${q}`;
  if (s.includes('up there'))                                 return `https://www.upthere.com.au/search?q=${q}`;
  if (s.includes('less 17'))                                  return `https://www.less17.com.au/search?q=${q}`;
  if (s.includes('cettire'))                                  return `https://www.cettire.com/au/search?q=${q}`;
  if (s.includes('ssense'))                                   return `https://www.ssense.com/en-au/search?q=${q}`;
  if (s.includes('pushas'))                                   return `https://www.pushas.com/search?q=${q}`;
  if (s.includes('limited edt') || s.includes('limitededt')) return `https://www.limitededt.com/search?q=${q}`;
  if (s.includes('mint company'))                             return `https://www.themintcompany.com/en/search?q=${q}`;
  if (s.includes('cruizeer'))                                 return `https://cruizeer.com/search?q=${q}`;
  if (s.includes('coproom'))                                  return `https://www.coproom.com.au/search?q=${q}`;
  if (s.includes('mr porter') || s.includes('mrporter'))      return `https://www.mrporter.com/en-au/search?q=${q}`;
  if (s.includes('highs and lows'))                           return `https://www.highsandlows.com/search?q=${q}`;
  if (s.includes('motion lifestyle'))                         return `https://www.motionlifestyle.com.au/search?q=${q}`;
  if (s.includes('usg store'))                                return `https://www.usgstore.com.au/search?q=${q}`;
  if (s.includes('prime athletic'))                           return `https://primeathletic.com.au/search?q=${q}`;
  if (s.includes('revolve'))                                  return `https://www.revolve.com/search/results/?q=${q}`;
  if (s.includes('solebox'))                                  return `https://www.solebox.com/en/search?q=${q}`;
  if (s.includes('laced'))                                    return `https://www.laced.com/search?q=${q}`;
  if (s.includes('sevenstore'))                               return `https://www.sevenstore.com/search?q=${q}`;
  if (s.includes('afew'))                                     return `https://www.afew-store.com/en/search?q=${q}`;
  if (s.includes('above the clouds'))                         return `https://www.abovetheclouds.com/search?q=${q}`;
  if (s.includes('sisters'))                                  return `https://www.sistersandco.com.au/search?q=${q}`;

  // Truly unknown — a guessed domain is often wrong, so let Google find the store's page
  console.log(`[StoreScout] Unknown store: "${storeName}"`);
  return `https://www.google.com/search?q=${encodeURIComponent(`${storeName} ${query}`)}`;
}

// Let tests load the helpers without starting the server
if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log(`[StoreScout] Backend running on http://${HOST}:${PORT}`);
    console.log(`[StoreScout] SerpAPI key: ${SERPAPI_KEY ? 'SET' : 'MISSING — add it to backend/.env'}`);
    console.log(`[StoreScout] Token: ${API_TOKEN ? 'required' : 'off'}`);
  });
}

module.exports = { app, buildQuery, normalizeBarcode, mentionsProduct, matchLevel, containsStyleCode, filterResults, toDeal, cheapestPerStore, easeScore, withCurrentPrice, isVerified, isMerchantUrl };
