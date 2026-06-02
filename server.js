const express = require('express');
const cors    = require('cors');

const app  = express();
const PORT = process.env.PORT || 3000;
const SERPAPI_KEY    = process.env.SERPAPI_KEY;
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

// ── Search ────────────────────────────────────────────────────────────
app.post('/api/search', async (req, res) => {
  const { identifier, identifierType, title, brand, currentPrice, currency: sourceCurrency, size, gender, color } = req.body;

  if (!SERPAPI_KEY) {
    return res.status(500).json({ error: 'SERPAPI_KEY not set', deals: [] });
  }

  const query = buildQuery(brand, title, identifier, identifierType, gender, color);
  if (!query.trim()) {
    return res.json({ deals: [] });
  }

  // Use style code for shopping search when available — locks results to exact colorway
  const shoppingQuery = (identifier && identifierType === 'sku')
    ? `${brand || ''} ${identifier}`.trim()
    : query;

  try {
    const params = new URLSearchParams({
      engine:   'google_shopping',
      q:        shoppingQuery,
      api_key:  SERPAPI_KEY,
      num:      '20',
      gl:       'au',
      hl:       'en',
      location: 'Australia',
    });

    // Fetch exchange rates in parallel with shopping search
    const [serpRes, fxRates] = await Promise.all([
      fetch(`https://serpapi.com/search.json?${params}`),
      fetchAUDRates(),
    ]);
    const serpData = await serpRes.json();

    if (serpData.error) {
      console.error('[StoreScout] SerpAPI returned error:', serpData.error);
      throw new Error(serpData.error);
    }

    let results = serpData.shopping_results || [];
    console.log(`[StoreScout] Shopping query: "${shoppingQuery}" → ${results.length} results`);

    // Filter early so we don't waste site: searches on blocked/wrong-gender results
    results = results
      .filter(r => r.source && (r.extracted_price || parsePrice(r.price)) > 0)
      .filter(r => !BLOCKED_STORES.some(b => (r.source || '').toLowerCase().includes(b)))
      .filter(r => !isWrongGender(r.title, gender))
      .filter(r => isSimilarProduct(r.title, title));

    const stores = [...new Set(results.map(r => r.source).filter(Boolean))];
    console.log(`[StoreScout] Stores: ${stores.join(', ')}`);

    // Use style code for site searches when available — much more specific than title
    const siteQuery = (identifier && identifierType === 'sku')
      ? `${brand || ''} ${identifier}`.trim()
      : query;
    console.log(`[StoreScout] Site search query: "${siteQuery}"`);

    // Run parallel per-store site: searches for direct product page URLs (top 10 stores)
    const directUrlsByDomain = await fetchPerStoreDirectUrls(siteQuery, stores.slice(0, 10), SERPAPI_KEY, size);

    const deals = results.map(item => {
        const delivery = (item.delivery || '').toLowerCase();
        const freeShip = delivery.includes('free');
        const shipping = freeShip ? 0 : extractShippingCost(item.delivery);
        const sale     = extractSalePercent(item.extensions || [], item.price, item.extracted_price);
        const store    = item.source || '';
        const rawPrice       = item.extracted_price || parsePrice(item.price);
        const currency       = detectCurrency(item.price, store);
        const extractedPrice = convertToAUD(rawPrice, currency, fxRates);
        const domain   = getStoreDomain(store);
        const directUrl = directUrlsByDomain[domain] || null;

        return {
          storeName:    store,
          title:        item.title || title,
          price:        extractedPrice,
          shipping,
          freeShipping: freeShip,
          salePercent:  sale,
          verified:     isVerified(store),
          pickup:       false,
          distance:     null,
          url:          directUrl || bestUrl(item.link, store, query),
          affiliateUrl: directUrl || bestUrl(item.link, store, query),
          image:        item.thumbnail || null,
          sameSize:     matchesSize(item.title, size),
          hasDirectUrl: !!directUrl,
          priceVaries:  isResalePlatform(getStoreDomain(store)),
        };
      })
      .filter(d => d.hasDirectUrl)
      .map(d => ({ ...d, affiliateUrl: applyAffiliateTag(d.affiliateUrl || d.url, d.storeName) }))
      .filter(d => isCheaper(d.price, currentPrice, sourceCurrency, fxRates));

    res.json({ deals });

  } catch (err) {
    console.error('[StoreScout] SerpAPI error:', err.message);
    res.json({ deals: [] });
  }
});

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
  const s = (storeName || '').toLowerCase();
  for (const [key, domain] of Object.entries(STORE_DOMAINS)) {
    if (s.includes(key)) return domain;
  }
  return s.replace(/[^a-z0-9]/g, '') + '.com';
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
        signal: AbortSignal.timeout(4000),
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
  q = q.replace(/\b(size\s*|US\s*|UK\s*|EU\s*)\d{1,3}(\.\d)?\b/gi, '');
  q = q.replace(/\b\d{1,2}(\.\d)?\s*(men'?s?|women'?s?|kids?'?s?)\b/gi, '');
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

function isCheaper(dealPrice, currentPrice, sourceCurrency, rates) {
  if (!dealPrice || !currentPrice) return true; // can't compare, let it through
  // Convert the source page's price to AUD for fair comparison
  const currentAUD = convertToAUD(parseFloat(currentPrice), (sourceCurrency || 'AUD').toUpperCase(), rates);
  return dealPrice < currentAUD;
}

function isSimilarProduct(resultTitle, originalTitle) {
  if (!resultTitle || !originalTitle) return true;

  const clean = s => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const orig   = clean(originalTitle);
  const result = clean(resultTitle);

  // Build bigrams (2-word pairs) from the original title
  const words  = orig.split(' ').filter(w => w.length >= 2);
  const bigrams = [];
  for (let i = 0; i < words.length - 1; i++) {
    bigrams.push(`${words[i]} ${words[i + 1]}`);
  }
  if (bigrams.length === 0) return true;

  // At least one bigram from the original must appear in the result title
  return bigrams.some(bg => result.includes(bg));
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

function extractSalePercent(extensions, priceStr, extracted) {
  for (const ext of extensions) {
    const m = String(ext).match(/(\d+)%\s*off/i);
    if (m) return parseInt(m[1]);
  }
  return 0;
}

function isVerified(storeName) {
  return VERIFIED_STORES.has(storeName.toLowerCase());
}

function bestUrl(serpLink, storeName, query) {
  // Use SerpAPI's link directly if it's already a real merchant URL (not a Google internal URL)
  if (serpLink && serpLink.startsWith('https://') && !serpLink.includes('google.com')) {
    return serpLink;
  }
  return storeSearchUrl(storeName, query);
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

  // Truly unknown
  console.log(`[StoreScout] Unknown store: "${storeName}"`);
  const domain = (storeName || '').toLowerCase().replace(/[^a-z0-9]/g, '') + '.com.au';
  return `https://www.${domain}/search?q=${q}`;
}

app.listen(PORT, () => {
  console.log(`[StoreScout] Backend running on port ${PORT}`);
  console.log(`[StoreScout] SerpAPI key: ${SERPAPI_KEY ? 'SET' : 'MISSING'}`);
});
