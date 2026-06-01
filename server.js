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

  const query = [brand, title].filter(Boolean).join(' ') || identifier || '';
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
    res.status(502).json({ error: err.message, deals: [] });
  }
});

// ── Helpers ───────────────────────────────────────────────────────────
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
