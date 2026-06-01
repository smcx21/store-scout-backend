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
  const { identifier, identifierType, title, brand, currentPrice } = req.body;

  if (!SERPAPI_KEY) {
    return res.status(500).json({ error: 'SERPAPI_KEY not set', deals: [] });
  }

  const query = buildQuery(brand, title, identifier, identifierType);
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
      throw new Error(serpData.error);
    }

    console.log(`[StoreScout] Query: "${query}" → ${(serpData.shopping_results || []).length} results`);
    if (serpData.shopping_results?.[0]) {
      const s = serpData.shopping_results[0];
      console.log(`[StoreScout] First result: ${s.source} | ${s.title} | link: ${s.product_link || s.link}`);
    }

    const deals = (serpData.shopping_results || [])
      .map(item => {
        const price    = parsePrice(item.price);
        const delivery = (item.delivery || '').toLowerCase();
        const freeShip = delivery.includes('free');
        const shipping = freeShip ? 0 : extractShippingCost(item.delivery);
        const sale     = extractSalePercent(item.extensions || [], item.price, item.extracted_price);
        const store    = item.source || '';

        const extractedPrice = item.extracted_price || parsePrice(item.price);
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
          url:          storeSearchUrl(item.source, query),
          affiliateUrl: storeSearchUrl(item.source, query),
          image:        item.thumbnail || null,
        };
      })
      .filter(d => d.storeName && d.price > 0);

    res.json({ deals });

  } catch (err) {
    console.error('[StoreScout] SerpAPI error:', err.message);
    res.json({ deals: [] });
  }
});

// ── Helpers ───────────────────────────────────────────────────────────
function buildQuery(brand, title, identifier, identifierType) {
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
  // Strip colorways after a dash (e.g. "- White/Black/Red")
  q = q.replace(/\s*[-–]\s*[\w\s/]+$/, '');
  // Strip standalone color words
  q = q.replace(/\b(white|black|grey|gray|blue|red|green|yellow|pink|purple|orange|brown|beige|navy|silver|gold|obsidian|volt|crimson)\b/gi, '');
  // Clean up punctuation and extra whitespace
  q = q.replace(/[()'"]+/g, '').replace(/\s+/g, ' ').trim();

  // Safety net: if cleaning left too little, use the original title
  if (q.length < 6) q = original.slice(0, 80).trim();

  // Prepend brand if not already in the cleaned title
  if (brand && !q.toLowerCase().includes(brand.toLowerCase())) {
    q = `${brand} ${q}`;
  }

  console.log(`[StoreScout] Built query: "${q}" (from title: "${(title || '').slice(0, 50)}")`);
  return q.slice(0, 100).trim();
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

function storeSearchUrl(storeName, query) {
  const s = (storeName || '').toLowerCase();
  const q = encodeURIComponent(query);
  if (s.includes('amazon'))                         return `https://www.amazon.com/s?k=${q}`;
  if (s.includes('walmart'))                        return `https://www.walmart.com/search?q=${q}`;
  if (s.includes('target'))                         return `https://www.target.com/s?searchTerm=${q}`;
  if (s.includes('ebay'))                           return `https://www.ebay.com/sch/i.html?_nkw=${q}`;
  if (s.includes('zappos'))                         return `https://www.zappos.com/search?term=${q}`;
  if (s.includes('foot locker') || s.includes('footlocker')) return `https://www.footlocker.com/search?query=${q}`;
  if (s.includes('nike'))                           return `https://www.nike.com/search?q=${q}`;
  if (s.includes('adidas'))                         return `https://www.adidas.com/us/search?q=${q}`;
  if (s.includes('nordstrom'))                      return `https://www.nordstrom.com/sr?origin=keywordsearch&keyword=${q}`;
  if (s.includes('macy'))                           return `https://www.macys.com/shop/featured/${q}`;
  if (s.includes('dsw'))                            return `https://www.dsw.com/en/us/search?searchtext=${q}`;
  if (s.includes('best buy') || s.includes('bestbuy')) return `https://www.bestbuy.com/site/searchpage.jsp?st=${q}`;
  if (s.includes('finish line') || s.includes('finishline')) return `https://www.finishline.com/store/search/?query=${q}`;
  return `https://www.google.com/search?tbm=shop&q=${q}`;
}

app.listen(PORT, () => {
  console.log(`[StoreScout] Backend running on port ${PORT}`);
  console.log(`[StoreScout] SerpAPI key: ${SERPAPI_KEY ? 'SET' : 'MISSING'}`);
});
