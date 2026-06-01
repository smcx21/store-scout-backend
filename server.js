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

    const deals = (serpData.shopping_results || [])
      .map(item => {
        const price    = parsePrice(item.price);
        const delivery = (item.delivery || '').toLowerCase();
        const freeShip = delivery.includes('free');
        const shipping = freeShip ? 0 : extractShippingCost(item.delivery);
        const sale     = extractSalePercent(item.extensions || [], item.price, item.extracted_price);
        const store    = item.source || '';

        return {
          storeName:    store,
          title:        item.title || title,
          price,
          shipping,
          freeShipping: freeShip,
          salePercent:  sale,
          verified:     isVerified(store),
          pickup:       false,
          distance:     null,
          url:          item.link || '#',
          affiliateUrl: item.link || '#',
          image:        item.thumbnail || null,
        };
      })
      .filter(d => d.price !== null && d.price > 0);

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

  // Strip shoe sizes like "Size 10", "10.5", "US 10", "EU 44"
  q = q.replace(/\b(size\s*)?\d{1,2}(\.\d)?\s*(us|uk|eu|men'?s?|women'?s?)?\b/gi, '');
  // Strip gendered descriptors
  q = q.replace(/\b(men'?s?|women'?s?|kids?'?s?|youth|unisex|toddler|infant|adult)\b/gi, '');
  // Strip generic footwear words that add no identity
  q = q.replace(/\b(running shoe|shoe|sneaker|trainer|boot|sandal|slipper)s?\b/gi, '');
  // Strip colorways after a dash (e.g. "- White/Black/Red")
  q = q.replace(/[-–]\s*[\w\s/]+$/, '');
  // Strip standalone color words
  q = q.replace(/\b(white|black|grey|gray|blue|red|green|yellow|pink|purple|orange|brown|beige|navy|silver|gold|obsidian|volt|crimson)\b/gi, '');
  // Clean up punctuation and extra whitespace
  q = q.replace(/[()'"]+/g, '').replace(/\s+/g, ' ').trim();

  // Prepend brand if not already in the cleaned title
  if (brand && !q.toLowerCase().includes(brand.toLowerCase())) {
    q = `${brand} ${q}`;
  }

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

app.listen(PORT, () => {
  console.log(`[StoreScout] Backend running on port ${PORT}`);
  console.log(`[StoreScout] SerpAPI key: ${SERPAPI_KEY ? 'SET' : 'MISSING'}`);
});
