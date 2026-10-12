/* =============================================================
   TSI COSMETICS — SHARED PRODUCT CATALOG & CART UTILITIES
   Edit PRODUCTS and BRANDS to update the store.
   All prices in ETB (indicative — confirm with owner).
   ============================================================= */

const PRODUCTS = [
  { id:'p1',  name:'Luxe Radiance Serum',          brand:'GlowLab',   category:'skincare',    shortDesc:'Brightening & anti-aging formula',   price:2640, image:'https://images.unsplash.com/photo-1596462502278-27bfdc403348?w=600&h=600&fit=crop', badge:'Featured', available:true  },
  { id:'p2',  name:'Velvet Matte Lipstick',         brand:'ColorPop',  category:'makeup',      shortDesc:'Long-lasting rich colour',            price:1540, image:'https://images.unsplash.com/photo-1631729371254-42c2892f0e6e?w=600&h=600&fit=crop', badge:'Featured', available:true  },
  { id:'p3',  name:'Hydra Dew Moisturizer',         brand:'AquaSkin',  category:'skincare',    shortDesc:'Deep hydration & glow',               price:2860, image:'https://images.unsplash.com/photo-1612817288484-6f916006741a?w=600&h=600&fit=crop', badge:'New',      available:true  },
  { id:'p4',  name:'Vitamin C Bright Serum',        brand:'GlowLab',   category:'skincare',    shortDesc:'Even tone & radiance',                price:3410, image:'https://images.unsplash.com/photo-1583241805055-1e1b5dd99d6d?w=600&h=600&fit=crop', badge:'Featured', available:true  },
  { id:'p5',  name:'Collagen Glow Complex',         brand:'VitaWell',  category:'supplements', shortDesc:'Skin support supplement',             price:4200, image:'https://images.unsplash.com/photo-1556228578-8c89e6adf883?w=600&h=600&fit=crop', badge:'New',      available:true  },
  { id:'p6',  name:'Argan Oil Hair Mask',           brand:'LuxeHair',  category:'haircare',    shortDesc:'Deep conditioning treatment',         price:1890, image:'https://images.unsplash.com/photo-1522337360788-8b13dee7a37e?w=600&h=600&fit=crop', badge:null,       available:true  },
  { id:'p7',  name:'Retinol Night Cream',           brand:'AquaSkin',  category:'skincare',    shortDesc:'Overnight renewal formula',           price:3750, image:'https://images.unsplash.com/photo-1570172619644-dfd03ed5d881?w=600&h=600&fit=crop', badge:null,       available:true  },
  { id:'p8',  name:'Setting Powder',                brand:'ColorPop',  category:'makeup',      shortDesc:'Mattifying finish, long wear',        price:1320, image:'https://images.unsplash.com/photo-1522335789203-aabd1fc54bc9?w=600&h=600&fit=crop', badge:null,       available:true  },
  { id:'p9',  name:'Biotin Hair Growth Supplement', brand:'VitaWell',  category:'supplements', shortDesc:'Supports healthy hair growth',        price:2970, image:'https://images.unsplash.com/photo-1544367567-0f2fcb009e0b?w=600&h=600&fit=crop', badge:null,       available:true  },
  { id:'p10', name:'Rose Water Toner',              brand:'GlowLab',   category:'skincare',    shortDesc:'Soothing & balancing mist',           price:1100, image:'https://images.unsplash.com/photo-1608248543803-ba4f8c70ae0b?w=600&h=600&fit=crop', badge:null,       available:true  },
  { id:'p11', name:'Keratin Shampoo',               brand:'LuxeHair',  category:'haircare',    shortDesc:'Smoothing, frizz control',            price:1650, image:'https://images.unsplash.com/photo-1585751119414-ef2636f8aede?w=600&h=600&fit=crop', badge:null,       available:true  },
  { id:'p12', name:'Volumizing Mascara',            brand:'ColorPop',  category:'makeup',      shortDesc:'Volume & length formula',             price:980,  image:'https://images.unsplash.com/photo-1631214524020-3c69b4f4b0ab?w=600&h=600&fit=crop', badge:null,       available:true  }
];

const BRANDS = [
  { id:'b1', name:'GlowLab',  cat:'Skincare',    desc:'Science-backed skincare with visible results. GlowLab focuses on serums, toners, and targeted treatments for brighter, healthier skin.' },
  { id:'b2', name:'ColorPop', cat:'Makeup',      desc:'Vibrant, long-wearing colour cosmetics. From lips to eyes, ColorPop delivers bold statement and everyday looks.' },
  { id:'b3', name:'AquaSkin', cat:'Skincare',    desc:'Hydration-first skincare for all skin types. AquaSkin products are gentle, effective, and deeply moisturising.' },
  { id:'b4', name:'VitaWell', cat:'Supplements', desc:'Health and beauty supplements to support skin, hair, and overall wellness. Always consult a healthcare professional before use.' },
  { id:'b5', name:'LuxeHair', cat:'Hair Care',   desc:'Professional-grade hair care treatments — from deep repair masks to daily shampoos for stronger, healthier hair.' },
  { id:'b6', name:'PureSkin', cat:'Skincare',    desc:'Clean, minimal formulations for sensitive and reactive skin types. Fewer ingredients, greater gentleness.' }
];

/* ---- Cart utilities (shared by index.html and order.html) ---- */
function tsiGetCart() {
  try { return JSON.parse(localStorage.getItem('tsi_cart') || '[]'); }
  catch { return []; }
}
function tsiSaveCart(c) { localStorage.setItem('tsi_cart', JSON.stringify(c)); }
function tsiGetProductById(id) { return PRODUCTS.find(p => p.id === id) || null; }
function tsiGetCartTotal() {
  return tsiGetCart().reduce((s, i) => {
    const p = tsiGetProductById(i.id);
    return p ? s + p.price * i.qty : s;
  }, 0);
}
function tsiGetCartCount() { return tsiGetCart().reduce((s, i) => s + i.qty, 0); }
function tsiAddToCart(id, qty) {
  qty = qty || 1;
  const c = tsiGetCart(), idx = c.findIndex(i => i.id === id);
  if (idx >= 0) c[idx].qty += qty; else c.push({ id, qty });
  tsiSaveCart(c);
}
function tsiRemoveFromCart(id) { tsiSaveCart(tsiGetCart().filter(i => i.id !== id)); }
function tsiUpdateQty(id, delta) {
  const c = tsiGetCart(), idx = c.findIndex(i => i.id === id);
  if (idx < 0) return;
  c[idx].qty += delta;
  if (c[idx].qty <= 0) c.splice(idx, 1);
  tsiSaveCart(c);
}
function tsiClearCart() { localStorage.removeItem('tsi_cart'); }
function tsiValidatePhone(val) {
  const v = val.trim().replace(/[\s\-().]/g, '');
  return /^(09|07)\d{8}$/.test(v) || /^\+251[79]\d{8}$/.test(v);
}
function tsiGenerateRef() {
  return 'TSI-' + Math.random().toString(36).substr(2, 6).toUpperCase();
}
