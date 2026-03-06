/**
 * LINE Bot + LIFF 點餐系統
 * 
 * 流程：
 *   客人傳訊息 → 回覆「開始點餐」按鈕（LIFF 連結）
 *   客人在 LIFF 網頁完成點餐 → 網頁呼叫 API 建立訂單
 *   後端透過 Push Message 發送訂單明細 Flex Message 到聊天室
 * 
 * 安裝：
 *   npm install @line/bot-sdk express better-sqlite3 dayjs cors
 */

const line = require('@line/bot-sdk');
const express = require('express');
const Database = require('better-sqlite3');
const dayjs = require('dayjs');
const cors = require('cors');
const path = require('path');

// ============================================================
// 設定
// ============================================================
const config = {
  channelSecret: process.env.LINE_CHANNEL_SECRET || 'YOUR_CHANNEL_SECRET',
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || 'YOUR_CHANNEL_ACCESS_TOKEN',
};

// ⚠️ 請在 LINE Developers 建立 LIFF App 後，把 LIFF ID 填在這裡
const LIFF_ID = process.env.LIFF_ID || 'YOUR_LIFF_ID';
const LIFF_URL = `https://liff.line.me/${LIFF_ID}`;

const client = new line.Client(config);
const app = express();

// 在 webhook 之前，先設定其他路由用的 middleware
// webhook 需要 raw body，所以要分開處理
app.use('/api', cors(), express.json());
app.use('/static', express.static(path.join(__dirname, 'public')));

// ============================================================
// 多件折扣設定
// ============================================================
const DISCOUNT_TIERS = [
  { minQty: 4, discount: 0.68, label: '68折' },
  { minQty: 3, discount: 0.70, label: '7折' },
  { minQty: 2, discount: 0.75, label: '75折' },
  { minQty: 1, discount: 0.80, label: '8折' },
];

function getDiscountForQty(qty) {
  for (const tier of DISCOUNT_TIERS) {
    if (qty >= tier.minQty) return tier;
  }
  return { minQty: 1, discount: 1, label: '原價' };
}

// ============================================================
// 付款 & 物流選項
// ============================================================
const PAYMENT_METHODS = [
  { id: 'cod', label: '💵 貨到付款', name: '貨到付款' },
  { id: 'atm', label: '🏧 ATM匯款', name: 'ATM匯款' },
  { id: 'jkopay', label: '📱 街口支付', name: '街口支付' },
  { id: 'linepay', label: '💚 LINE Pay', name: 'LINE Pay' },
];

const SHIPPING_METHODS = [
  { id: 'pickup', label: '🏪 自行取貨', name: '自行取貨', fee: 0 },
  { id: '711', label: '🏪 7-11賣貨便', name: '7-11賣貨便', fee: 60 },
  { id: 'post', label: '📦 郵局宅配', name: '郵局宅配', fee: 80 },
];

// ============================================================
// 資料庫初始化
// ============================================================
const db = new Database('orders.db');
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS menu (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL,
    name TEXT NOT NULL,
    price INTEGER NOT NULL,
    image_url TEXT,
    has_discount INTEGER DEFAULT 0,
    is_available INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_no TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL,
    subtotal INTEGER NOT NULL DEFAULT 0,
    discount_amount INTEGER DEFAULT 0,
    shipping_fee INTEGER DEFAULT 0,
    total INTEGER NOT NULL,
    payment_method TEXT,
    shipping_method TEXT,
    status TEXT DEFAULT 'pending',
    items_json TEXT,
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  );
`);

// 預設菜單
const menuCount = db.prepare('SELECT COUNT(*) as cnt FROM menu').get();
if (menuCount.cnt === 0) {
  const ins = db.prepare('INSERT INTO menu (category, name, price, image_url, has_discount) VALUES (?,?,?,?,?)');
  const items = [
    ['飲品', '珍珠奶茶', 55, 'https://via.placeholder.com/300x200/8B4513/FFFFFF?text=珍珠奶茶', 0],
    ['飲品', '綠茶拿鐵', 60, 'https://via.placeholder.com/300x200/228B22/FFFFFF?text=綠茶拿鐵', 0],
    ['飲品', '芒果冰沙', 65, 'https://via.placeholder.com/300x200/FFD700/000000?text=芒果冰沙', 0],
    ['飲品', '美式咖啡', 45, 'https://via.placeholder.com/300x200/3E2723/FFFFFF?text=美式咖啡', 0],
    ['輕食', '起司三明治', 50, 'https://via.placeholder.com/300x200/FFA500/FFFFFF?text=起司三明治', 0],
    ['輕食', '鮪魚飯糰', 35, 'https://via.placeholder.com/300x200/4682B4/FFFFFF?text=鮪魚飯糰', 0],
    ['輕食', '雞肉沙拉', 80, 'https://via.placeholder.com/300x200/32CD32/FFFFFF?text=雞肉沙拉', 0],
    ['甜點', '提拉米蘇', 75, 'https://via.placeholder.com/300x200/D2691E/FFFFFF?text=提拉米蘇', 1],
    ['甜點', '草莓蛋糕', 85, 'https://via.placeholder.com/300x200/FF69B4/FFFFFF?text=草莓蛋糕', 1],
  ];
  db.transaction(() => { for (const i of items) ins.run(...i); })();
  console.log('✅ 已插入範例菜單');
}

// ============================================================
// 折扣計算
// ============================================================
function calculateOrder(cartItems, menuMap) {
  const discountItems = cartItems.filter(i => menuMap[i.id]?.has_discount);
  const totalDiscountQty = discountItems.reduce((s, i) => s + i.qty, 0);
  const tier = getDiscountForQty(totalDiscountQty);

  let subtotal = 0;
  let discountAmount = 0;
  const details = [];

  for (const item of cartItems) {
    const menu = menuMap[item.id];
    if (!menu) continue;
    const orig = menu.price * item.qty;
    subtotal += orig;

    if (menu.has_discount && totalDiscountQty >= 1) {
      const disc = Math.round(orig * tier.discount);
      discountAmount += orig - disc;
      details.push({ name: menu.name, price: menu.price, qty: item.qty, originalPrice: orig, finalPrice: disc, discountLabel: tier.label, hasItemDiscount: true });
    } else {
      details.push({ name: menu.name, price: menu.price, qty: item.qty, originalPrice: orig, finalPrice: orig, discountLabel: null, hasItemDiscount: false });
    }
  }

  return { subtotal, discountAmount, discountTier: totalDiscountQty >= 1 ? tier : null, totalDiscountQty, itemDetails: details, total: subtotal - discountAmount };
}

// ============================================================
// 訂單建立
// ============================================================
function generateOrderNo() {
  return `ORD${dayjs().format('YYMMDDHHmmss')}${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`;
}

// ============================================================
// 訂單明細 Flex Message
// ============================================================
function buildOrderReceiptFlex(order) {
  const { orderNo, subtotal, discountAmount, discountTier, shippingFee, shippingName, paymentName, total, items } = order;
  const now = dayjs().format('YYYY/MM/DD HH:mm');

  const body = [
    { type: 'box', layout: 'horizontal', contents: [
      { type: 'text', text: '下單時間', size: 'xs', color: '#AAAAAA', flex: 2 },
      { type: 'text', text: now, size: 'xs', color: '#666666', align: 'end', flex: 3 },
    ]},
    { type: 'box', layout: 'horizontal', margin: 'sm', contents: [
      { type: 'text', text: '付款方式', size: 'xs', color: '#AAAAAA', flex: 2 },
      { type: 'text', text: paymentName, size: 'xs', color: '#666666', align: 'end', flex: 3 },
    ]},
    { type: 'box', layout: 'horizontal', margin: 'sm', contents: [
      { type: 'text', text: '物流方式', size: 'xs', color: '#AAAAAA', flex: 2 },
      { type: 'text', text: shippingName, size: 'xs', color: '#666666', align: 'end', flex: 3 },
    ]},
    { type: 'separator', margin: 'lg' },
    { type: 'text', text: '商品明細', size: 'sm', weight: 'bold', color: '#333333', margin: 'lg' },
    ...items.map(item => ({
      type: 'box', layout: 'horizontal', margin: 'md', contents: [
        { type: 'text', text: item.name, size: 'sm', color: '#555555', flex: 3 },
        { type: 'text', text: `x${item.qty}`, size: 'sm', color: '#999999', flex: 1, align: 'center' },
        { type: 'text', text: `$${item.finalPrice}`, size: 'sm', color: item.hasItemDiscount ? '#E74C3C' : '#333333', flex: 1, align: 'end', weight: 'bold' },
      ],
    })),
    { type: 'separator', margin: 'xl' },
    { type: 'box', layout: 'horizontal', margin: 'lg', contents: [
      { type: 'text', text: '商品小計', size: 'sm', color: '#999999', flex: 3 },
      { type: 'text', text: `$${subtotal}`, size: 'sm', color: '#333333', flex: 2, align: 'end' },
    ]},
  ];

  if (discountAmount > 0) {
    body.push({ type: 'box', layout: 'horizontal', margin: 'sm', contents: [
      { type: 'text', text: `折扣（${discountTier.label}）`, size: 'sm', color: '#E74C3C', flex: 3 },
      { type: 'text', text: `-$${discountAmount}`, size: 'sm', color: '#E74C3C', flex: 2, align: 'end' },
    ]});
  }

  body.push({ type: 'box', layout: 'horizontal', margin: 'sm', contents: [
    { type: 'text', text: '運費', size: 'sm', color: '#999999', flex: 3 },
    { type: 'text', text: shippingFee > 0 ? `$${shippingFee}` : '免運', size: 'sm', color: '#333333', flex: 2, align: 'end' },
  ]});
  body.push({ type: 'separator', margin: 'lg' });
  body.push({ type: 'box', layout: 'horizontal', margin: 'lg', contents: [
    { type: 'text', text: '應付金額', size: 'lg', weight: 'bold', color: '#333333', flex: 3 },
    { type: 'text', text: `$${total}`, size: 'xl', weight: 'bold', color: '#27ACB2', flex: 2, align: 'end' },
  ]});

  return {
    type: 'flex', altText: `訂單明細 #${orderNo} - $${total}`,
    contents: {
      type: 'bubble',
      styles: { header: { backgroundColor: '#27ACB2' }, footer: { backgroundColor: '#F7F7F7' } },
      header: { type: 'box', layout: 'vertical', paddingAll: '20px', contents: [{
        type: 'box', layout: 'horizontal', contents: [
          { type: 'text', text: '📋', size: 'xl', flex: 0 },
          { type: 'box', layout: 'vertical', margin: 'lg', contents: [
            { type: 'text', text: '訂單確認', color: '#FFFFFF', weight: 'bold', size: 'xl' },
            { type: 'text', text: `#${orderNo}`, color: '#DDDDDD', size: 'xs', margin: 'sm' },
          ]},
        ],
      }]},
      body: { type: 'box', layout: 'vertical', paddingAll: '20px', contents: body },
      footer: { type: 'box', layout: 'vertical', paddingAll: '15px', contents: [
        { type: 'box', layout: 'vertical', contents: [
          { type: 'text', text: '✅ 訂單已成立，我們正在為您準備！', size: 'xs', color: '#27ACB2', weight: 'bold', align: 'center' },
          { type: 'text', text: '如需修改請聯繫客服', size: 'xxs', color: '#AAAAAA', align: 'center', margin: 'sm' },
        ]},
        { type: 'button', action: { type: 'uri', label: '🔄 再點一次', uri: LIFF_URL }, style: 'primary', color: '#27ACB2', height: 'sm', margin: 'lg' },
      ]},
    },
  };
}

// ============================================================
// API 路由（給 LIFF 前端用）
// ============================================================

// 取得菜單
app.get('/api/menu', (req, res) => {
  const items = db.prepare('SELECT * FROM menu WHERE is_available=1').all();
  const categories = [...new Set(items.map(i => i.category))];
  res.json({ categories, items, discountTiers: DISCOUNT_TIERS, paymentMethods: PAYMENT_METHODS, shippingMethods: SHIPPING_METHODS });
});

// 計算價格（預覽）
app.post('/api/calculate', (req, res) => {
  const { cart, shippingId } = req.body;
  if (!cart || !cart.length) return res.status(400).json({ error: '購物車是空的' });

  const menuMap = {};
  for (const item of cart) {
    const m = db.prepare('SELECT * FROM menu WHERE id=? AND is_available=1').get(item.id);
    if (m) menuMap[item.id] = m;
  }

  const calc = calculateOrder(cart, menuMap);
  const shipping = SHIPPING_METHODS.find(s => s.id === shippingId) || SHIPPING_METHODS[0];

  res.json({
    ...calc,
    shippingFee: shipping.fee,
    shippingName: shipping.name,
    finalTotal: calc.total + shipping.fee,
  });
});

// 送出訂單
app.post('/api/order', async (req, res) => {
  const { userId, cart, paymentId, shippingId } = req.body;
  if (!userId || !cart || !cart.length) return res.status(400).json({ error: '資料不完整' });

  const menuMap = {};
  for (const item of cart) {
    const m = db.prepare('SELECT * FROM menu WHERE id=? AND is_available=1').get(item.id);
    if (m) menuMap[item.id] = m;
  }

  const calc = calculateOrder(cart, menuMap);
  const shipping = SHIPPING_METHODS.find(s => s.id === shippingId) || SHIPPING_METHODS[0];
  const payment = PAYMENT_METHODS.find(p => p.id === paymentId) || PAYMENT_METHODS[0];
  const orderNo = generateOrderNo();
  const finalTotal = calc.total + shipping.fee;

  // 儲存訂單
  db.prepare(`INSERT INTO orders (order_no,user_id,subtotal,discount_amount,shipping_fee,total,payment_method,shipping_method,items_json) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(orderNo, userId, calc.subtotal, calc.discountAmount, shipping.fee, finalTotal, payment.name, shipping.name, JSON.stringify(calc.itemDetails));

  // 透過 Push Message 發送訂單明細到聊天室
  const order = {
    orderNo, subtotal: calc.subtotal, discountAmount: calc.discountAmount, discountTier: calc.discountTier,
    shippingFee: shipping.fee, shippingName: shipping.name, paymentName: payment.name, total: finalTotal, items: calc.itemDetails,
  };

  try {
    await client.pushMessage(userId, buildOrderReceiptFlex(order));
    res.json({ success: true, orderNo, total: finalTotal });
  } catch (err) {
    console.error('Push message error:', err.message);
    if (err.originalError?.response?.data) {
      console.error('LINE API error detail:', JSON.stringify(err.originalError.response.data));
    }
    res.json({ success: true, orderNo, total: finalTotal, pushError: '訂單已建立，但訊息發送失敗' });
  }
});

// ============================================================
// LINE Webhook（只處理歡迎訊息）
// ============================================================
app.post('/webhook', line.middleware(config), async (req, res) => {
  try { await Promise.all(req.body.events.map(handleEvent)); }
  catch (err) { console.error('Webhook error:', err); }
  res.json({ success: true });
});

async function handleEvent(event) {
  if (event.type === 'message' && event.message.type === 'text') {
    return client.replyMessage(event.replyToken, {
      type: 'flex', altText: '歡迎光臨！點此開始點餐',
      contents: {
        type: 'bubble',
        styles: { header: { backgroundColor: '#FF6B35' } },
        header: { type: 'box', layout: 'vertical', paddingAll: '20px', contents: [
          { type: 'text', text: '☕ 歡迎光臨', color: '#FFFFFF', weight: 'bold', size: 'xl', align: 'center' },
          { type: 'text', text: '點擊下方按鈕開始點餐', color: '#DDDDDD', size: 'sm', align: 'center', margin: 'md' },
        ]},
        body: { type: 'box', layout: 'vertical', paddingAll: '20px', contents: [
          { type: 'text', text: '🍰 精選甜點多件折扣中！', size: 'sm', color: '#E74C3C', align: 'center' },
          { type: 'text', text: '1件8折｜2件75折｜3件7折｜4件↑68折', size: 'xs', color: '#999999', align: 'center', margin: 'sm' },
        ]},
        footer: { type: 'box', layout: 'vertical', paddingAll: '15px', contents: [
          { type: 'button', action: { type: 'uri', label: '📋 開始點餐', uri: LIFF_URL }, style: 'primary', color: '#FF6B35', height: 'md' },
        ]},
      },
    });
  }

  if (event.type === 'follow') {
    return client.replyMessage(event.replyToken, {
      type: 'flex', altText: '歡迎加入！',
      contents: {
        type: 'bubble',
        styles: { header: { backgroundColor: '#FF6B35' } },
        header: { type: 'box', layout: 'vertical', paddingAll: '20px', contents: [
          { type: 'text', text: '🎉 歡迎加入！', color: '#FFFFFF', weight: 'bold', size: 'xl', align: 'center' },
        ]},
        footer: { type: 'box', layout: 'vertical', paddingAll: '15px', contents: [
          { type: 'button', action: { type: 'uri', label: '📋 開始點餐', uri: LIFF_URL }, style: 'primary', color: '#FF6B35' },
        ]},
      },
    });
  }

  return null;
}

// ============================================================
// LIFF 前端頁面
// ============================================================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================================
// 啟動
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 LINE Bot + LIFF 伺服器已啟動：http://localhost:${PORT}`);
  console.log(`📦 菜單品項數: ${db.prepare('SELECT COUNT(*) as cnt FROM menu').get().cnt}`);
  console.log(`🔗 LIFF URL: ${LIFF_URL}`);
});
