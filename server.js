const express = require('express');
const cors    = require('cors');

const app  = express();
const PORT = process.env.PORT || 3000;
const SERPAPI_KEY = process.env.SERPAPI_KEY;

const VERIFIED_STORES = new Set([
  'amazon', 'walmart', 'target', 'bestbuy', 'best buy', 'ebay', 'etsy',
  'zappos', 'foot locker', 'footlocker', 'nike', 'adidas', 'nordstrom',
  'macy\'s', 'macys', 'gap', 'zara', 'asos', 'dsw', 'newegg',
  'costco', 'home depot', 'homedepot', 'wayfair', 'chewy', 'overstock',
]);

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
      engine:  'google_shopping',
      q:       query,
      api_key: SERPAPI_KEY,
      num:     '20',
      gl:      'us',
      hl:      'en',
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
      .filter(d => !isWrongGender(d.title, gender));

    res.json({ deals });

  } catch (err) {
    console.error('[StoreScout] SerpAPI error:', err.message);
    res.json({ deals: [] });
  }
});

// ── Helpers ───────────────────────────────────────────────────────────
const STORE_DOMAINS = {
  'amazon': 'amazon.com', 'walmart': 'walmart.com', 'target': 'target.com',
  'ebay': 'ebay.com', 'zappos': 'zappos.com',
  'foot locker': 'footlocker.com', 'footlocker': 'footlocker.com',
  'champs': 'champssports.com', 'nike': 'nike.com', 'adidas': 'adidas.com',
  'nordstrom rack': 'nordstromrack.com', 'nordstrom': 'nordstrom.com',
  "macy's": 'macys.com', 'macys': 'macys.com', 'dsw': 'dsw.com',
  'best buy': 'bestbuy.com', 'finish line': 'finishline.com',
  "dick's": 'dickssportinggoods.com', 'dicks': 'dickssportinggoods.com',
  '6pm': '6pm.com', 'new balance': 'newbalance.com', 'reebok': 'reebok.com',
  'puma': 'puma.com', 'under armour': 'underarmour.com',
  'converse': 'converse.com', 'vans': 'vans.com', 'skechers': 'skechers.com',
  'asics': 'asics.com', 'brooks': 'brooksrunning.com', 'hoka': 'hoka.com',
  'on running': 'on-running.com', 'etsy': 'etsy.com', 'asos': 'asos.com',
  'zara': 'zara.com', 'dtlr': 'dtlr.com', 'hibbett': 'hibbett.com',
  'jd sports': 'jdsports.com', 'snipes': 'snipesusa.com',
  'shiekh': 'shiekh.com', 'sole classics': 'soleclassics.com',
  'goat': 'goat.com', 'mr porter': 'mrporter.com',
  "al's sporting": 'alssportinggoods.com',
  'stockx': 'stockx.com', 'flight club': 'flightclub.com',
  'lyst': 'lyst.com', 'stadium goods': 'stadiumgoods.com',
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
    engine:  'google',
    q:       `${query} buy`,
    api_key: apiKey,
    num:     '20',
    gl:      'us',
    hl:      'en',
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

  if (s.includes('amazon'))                                    return `https://www.amazon.com/s?k=${q}`;
  if (s.includes('walmart'))                                   return `https://www.walmart.com/search?q=${q}`;
  if (s.includes('target'))                                    return `https://www.target.com/s?searchTerm=${q}`;
  if (s.includes('ebay'))                                      return `https://www.ebay.com/sch/i.html?_nkw=${q}`;
  if (s.includes('zappos'))                                    return `https://www.zappos.com/search?term=${q}`;
  if (s.includes('foot locker') || s.includes('footlocker'))  return `https://www.footlocker.com/search?query=${q}`;
  if (s.includes('champs'))                                    return `https://www.champssports.com/search?query=${q}`;
  if (s.includes('nike'))                                      return `https://www.nike.com/search?q=${q}`;
  if (s.includes('adidas'))                                    return `https://www.adidas.com/us/search?q=${q}`;
  if (s.includes('nordstrom rack'))                            return `https://www.nordstromrack.com/sr?keyword=${q}`;
  if (s.includes('nordstrom'))                                 return `https://www.nordstrom.com/sr?origin=keywordsearch&keyword=${q}`;
  if (s.includes('macy'))                                      return `https://www.macys.com/shop/search?keyword=${q}`;
  if (s.includes('dsw'))                                       return `https://www.dsw.com/en/us/search?searchtext=${q}`;
  if (s.includes('best buy') || s.includes('bestbuy'))        return `https://www.bestbuy.com/site/searchpage.jsp?st=${q}`;
  if (s.includes('finish line') || s.includes('finishline'))  return `https://www.finishline.com/store/search/?query=${q}`;
  if (s.includes("dick's") || s.includes('dicks sporting'))   return `https://www.dickssportinggoods.com/search/endeca?searchTerm=${q}`;
  if (s.includes('6pm'))                                       return `https://www.6pm.com/search?term=${q}`;
  if (s.includes('new balance'))                               return `https://www.newbalance.com/en-us/search/?q=${q}`;
  if (s.includes('reebok'))                                    return `https://www.reebok.com/en-us/search?q=${q}`;
  if (s.includes('puma'))                                      return `https://us.puma.com/en_US/search?q=${q}`;
  if (s.includes('under armour'))                              return `https://www.underarmour.com/en-us/search?q=${q}`;
  if (s.includes('converse'))                                  return `https://www.converse.com/en-us/search?q=${q}`;
  if (s.includes('vans'))                                      return `https://www.vans.com/en-us/search?q=${q}`;
  if (s.includes('skechers'))                                  return `https://www.skechers.com/en-us/search?q=${q}`;
  if (s.includes('asics'))                                     return `https://www.asics.com/us/en-us/search?q=${q}`;
  if (s.includes('brooks'))                                    return `https://www.brooksrunning.com/en_us/search?q=${q}`;
  if (s.includes('hoka'))                                      return `https://www.hoka.com/en-us/search?q=${q}`;
  if (s.includes('on running') || s.includes('on cloud'))     return `https://www.on-running.com/en-us/search?q=${q}`;
  if (s.includes('running warehouse'))                         return `https://www.runningwarehouse.com/searchresults.html?Ntk=All&Ntt=${q}`;
  if (s.includes('road runner'))                               return `https://www.roadrunnersports.com/search?q=${q}`;
  if (s.includes('academy'))                                   return `https://www.academy.com/shop/catalog/search?q=${q}`;
  if (s.includes('etsy'))                                      return `https://www.etsy.com/search?q=${q}`;
  if (s.includes('asos'))                                      return `https://www.asos.com/us/search?q=${q}`;
  if (s.includes('zara'))                                      return `https://www.zara.com/us/en/search?searchTerm=${q}`;
  if (s.includes('dtlr'))                                      return `https://www.dtlr.com/search?q=${q}`;
  if (s.includes('hibbett'))                                   return `https://www.hibbett.com/search?q=${q}`;
  if (s.includes('jd sports'))                                 return `https://www.jdsports.com/search/?searchText=${q}`;
  if (s.includes('snipes'))                                    return `https://www.snipesusa.com/search?q=${q}`;
  if (s.includes('shiekh'))                                    return `https://www.shiekh.com/search/?q=${q}`;
  if (s.includes('sole classics'))                             return `https://www.soleclassics.com/search?type=product&q=${q}`;
  if (s.includes('goat'))                                      return `https://www.goat.com/search?query=${q}`;
  if (s.includes('mr porter') || s.includes('mrporter'))      return `https://www.mrporter.com/en-us/search?q=${q}`;
  if (s.includes("al's sporting") || s.includes('als sport')) return `https://www.alssportinggoods.com/search?q=${q}`;

  if (s.includes('stockx'))                                    return `https://stockx.com/search?s=${q}`;
  if (s.includes('flight club'))                               return `https://www.flightclub.com/search?q=${q}`;
  if (s.includes('lyst'))                                      return `https://www.lyst.com/search/?q=${q}`;
  if (s.includes('stadium goods'))                             return `https://www.stadiumgoods.com/search?q=${q}`;

  // Truly unknown — log it and try to guess the domain
  console.log(`[StoreScout] Unknown store: "${storeName}"`);
  const domain = (storeName || '').toLowerCase().replace(/[^a-z0-9]/g, '') + '.com';
  return `https://www.${domain}/search?q=${q}`;
}

app.listen(PORT, () => {
  console.log(`[StoreScout] Backend running on port ${PORT}`);
  console.log(`[StoreScout] SerpAPI key: ${SERPAPI_KEY ? 'SET' : 'MISSING'}`);
});
