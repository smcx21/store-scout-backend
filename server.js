const express = require('express');
const cors    = require('cors');

const app  = express();
const PORT = process.env.PORT || 3000;
const SERPAPI_KEY = process.env.SERPAPI_KEY;

const VERIFIED_STORES = new Set([
  'nike', 'adidas', 'foot locker', 'footlocker', 'jd sports', 'asos',
  'the iconic', 'platypus', 'hype dc', 'rebel sport', 'culture kings',
  'stylerunner', 'glue store', 'amazon', 'myer', 'david jones',
  'converse', 'vans', 'puma', 'reebok', 'new balance', 'asics',
  'hoka', 'under armour', 'goat', 'stockx',
]);

const BLOCKED_STORES = new Set(['ebay']);

app.use(cors());
app.use(express.json());

// ── Health check ──────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', serpapi: !!SERPAPI_KEY });
});

// ── Search ────────────────────────────────────────────────────────────
app.post('/api/search', async (req, res) => {
  const { identifier, identifierType, title, brand, currentPrice, size, gender, color } = req.body;

  if (!SERPAPI_KEY) {
    return res.status(500).json({ error: 'SERPAPI_KEY not set', deals: [] });
  }

  const query = buildQuery(brand, title, identifier, identifierType, gender, color);
  if (!query.trim()) {
    return res.json({ deals: [] });
  }

  try {
    const params = new URLSearchParams({
      engine:   'google_shopping',
      q:        query,
      api_key:  SERPAPI_KEY,
      num:      '20',
      gl:       'au',
      hl:       'en',
      location: 'Australia',
    });

    const serpRes  = await fetch(`https://serpapi.com/search.json?${params}`);
    const serpData = await serpRes.json();

    if (serpData.error) {
      console.error('[StoreScout] SerpAPI returned error:', serpData.error);
      throw new Error(serpData.error);
    }

    const results = serpData.shopping_results || [];
    console.log(`[StoreScout] Query: "${query}" → ${results.length} results`);
    const stores = [...new Set(results.map(r => r.source).filter(Boolean))];
    console.log(`[StoreScout] Stores returned: ${stores.join(', ')}`);

    // Run targeted organic search using site: operators for the exact stores returned
    const directUrlsPromise = fetchDirectUrlsBySearch(query, stores, SERPAPI_KEY);

    const directUrlsByDomain = await directUrlsPromise;

    const deals = results
      .map(item => {
        const delivery = (item.delivery || '').toLowerCase();
        const freeShip = delivery.includes('free');
        const shipping = freeShip ? 0 : extractShippingCost(item.delivery);
        const sale     = extractSalePercent(item.extensions || [], item.price, item.extracted_price);
        const store    = item.source || '';
        const extractedPrice = item.extracted_price || parsePrice(item.price);
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
        };
      })
      .filter(d => d.storeName && d.price > 0)
      .filter(d => !isWrongGender(d.title, gender))
      .filter(d => !BLOCKED_STORES.has(d.storeName.toLowerCase().split(' ')[0]));

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
  // Resale
  'goat': 'goat.com', 'stockx': 'stockx.com',
  'flight club': 'flightclub.com', 'lyst': 'lyst.com',
};

function getStoreDomain(storeName) {
  const s = (storeName || '').toLowerCase();
  for (const [key, domain] of Object.entries(STORE_DOMAINS)) {
    if (s.includes(key)) return domain;
  }
  return s.replace(/[^a-z0-9]/g, '') + '.com';
}

async function fetchDirectUrlsBySearch(query, storeNames, apiKey) {
  const params = new URLSearchParams({
    engine:   'google',
    q:        `${query} buy australia`,
    api_key:  apiKey,
    num:      '20',
    gl:       'au',
    hl:       'en',
    location: 'Australia',
  });

  // Build a set of domains we're looking for so we can stop early
  const targetDomains = new Set(storeNames.map(s => getStoreDomain(s)).filter(Boolean));

  try {
    const res = await fetch(`https://serpapi.com/search.json?${params}`, {
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json();
    const urlsByDomain = {};
    for (const result of (data.organic_results || [])) {
      try {
        const hostname = new URL(result.link).hostname.replace(/^www\./, '');
        if (!urlsByDomain[hostname] && targetDomains.has(hostname)) {
          urlsByDomain[hostname] = result.link;
          console.log(`[StoreScout] Direct URL: ${hostname} → ${result.link}`);
        }
      } catch {}
    }
    return urlsByDomain;
  } catch (err) {
    console.log(`[StoreScout] Organic search failed: ${err.message}`);
    return {};
  }
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

  // Resale (global, ship to AU)
  if (s.includes('goat'))                                     return `https://www.goat.com/search?query=${q}`;
  if (s.includes('stockx'))                                   return `https://stockx.com/search?s=${q}`;
  if (s.includes('flight club'))                              return `https://www.flightclub.com/search?q=${q}`;
  if (s.includes('lyst'))                                     return `https://www.lyst.com/search/?q=${q}`;

  // Truly unknown
  console.log(`[StoreScout] Unknown store: "${storeName}"`);
  const domain = (storeName || '').toLowerCase().replace(/[^a-z0-9]/g, '') + '.com.au';
  return `https://www.${domain}/search?q=${q}`;
}

app.listen(PORT, () => {
  console.log(`[StoreScout] Backend running on port ${PORT}`);
  console.log(`[StoreScout] SerpAPI key: ${SERPAPI_KEY ? 'SET' : 'MISSING'}`);
});
