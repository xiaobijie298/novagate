const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
app.set('trust proxy', true);  // 支持 Railway 等反向代理获取真实 IP
const PORT = process.env.PORT || 3000;
const QWEN_API_KEY = process.env.QWEN_API_KEY;
const QWEN_ENDPOINT = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
const USERS_FILE = path.join(__dirname, 'users.json');
const LOGS_FILE = path.join(__dirname, 'logs.json');
const TRAFFIC_FILE = path.join(__dirname, 'traffic.json');

// ============ 免费试用配置 ============
const TRIAL_CLAIMS = new Map(); // ip -> timestamp
const TRIAL_QUOTA = 10000;     // 试用额度：1万 tokens
const TRIAL_WINDOW_MS = 24 * 60 * 60 * 1000; // 24小时内每IP限领1次

// ============ 支付配置 ============
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || '';
const PAYPAL_SECRET   = process.env.PAYPAL_SECRET || '';
const PROMPT_PAY_PHONE = process.env.PROMPT_PAY_PHONE || '';
const PAYPAL_MODE      = process.env.PAYPAL_MODE || 'sandbox';
const PAYPAL_API = PAYPAL_MODE === 'live'
  ? 'https://api-m.paypal.com'
  : 'https://api-m.sandbox.paypal.com';

// ============ 套餐定价（会员制） ============
const PRICING_PLANS = {
  starter: {
    name: 'Starter',
    name_th: 'เริ่มต้น',
    description: '0.5M tokens — สำหรับทดลองใช้งาน',
    amount_thb: 50,
    quota: 500_000,
  },
  basic: {
    name: 'Basic',
    name_th: 'เบสิก',
    description: '10M tokens — สำหรับผู้ขายรายย่อย',
    amount_thb: 999,
    quota: 10_000_000,
  },
  pro: {
    name: 'Pro',
    name_th: 'โปร',
    description: '50M tokens — สำหรับร้านค้าขนาดกลาง',
    amount_thb: 2999,
    quota: 50_000_000,
  },
  business: {
    name: 'Business',
    name_th: 'บิสสิเนส',
    description: '200M tokens — สำหรับเจ้าของขนาดใหญ่',
    amount_thb: 9999,
    quota: 200_000_000,
  }
};

// ============ 用量计价（按量付费） ============
function calculateQuota(amountThb) {
  const amount = Number(amountThb);
  if (!amount || amount < 50) return null;
  let tokensPerBaht;
  if (amount >= 5000)      tokensPerBaht = 15000;
  else if (amount >= 2000)  tokensPerBaht = 14000;
  else if (amount >= 1000)  tokensPerBaht = 13000;
  else if (amount >= 500)   tokensPerBaht = 12000;
  else if (amount >= 200)   tokensPerBaht = 11000;
  else if (amount >= 100)   tokensPerBaht = 10000;
  else                       tokensPerBaht = 9000;   // 50-99 THB
  const quota = Math.floor(amount * tokensPerBaht);
  return {
    amount_thb: amount,
    quota,
    tokens_per_baht: tokensPerBaht,
    description: `${quota.toLocaleString()} tokens — ฿${amount.toLocaleString()}`
  };
}

function getPricingTable() {
  return [50, 100, 200, 500, 1000, 2000, 5000].map(t => calculateQuota(t));
}

// ============ 中间件 ============
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// ============ 流量监控中间件 ============
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    const rawIp = req.ip || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '';
    const ip = String(rawIp).split(',')[0].trim();
    logTraffic({
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration,
      ip,
      ua: (req.headers['user-agent'] || '').slice(0, 80)
    });
  });
  next();
});

// ============ 日志系统 ============
function loadLogs() {
  if (!fs.existsSync(LOGS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(LOGS_FILE, 'utf8')); } catch { return []; }
}
function saveLogs(logs) {
  const trimmed = logs.length > 5000 ? logs.slice(logs.length - 5000) : logs;
  fs.writeFileSync(LOGS_FILE, JSON.stringify(trimmed, null, 2));
}
function writeLog(entry) {
  const logs = loadLogs();
  logs.push({ id: logs.length + 1, timestamp: new Date().toISOString(), ...entry });
  saveLogs(logs);
}

// ============ 流量日志（精简版，用于统计） ============
function loadTraffic() {
  if (!fs.existsSync(TRAFFIC_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(TRAFFIC_FILE, 'utf8')); } catch { return []; }
}
function saveTraffic(data) {
  const trimmed = data.length > 10000 ? data.slice(data.length - 10000) : data;
  fs.writeFileSync(TRAFFIC_FILE, JSON.stringify(trimmed));
}
function logTraffic(entry) {
  const t = loadTraffic();
  t.push({ ts: new Date().toISOString(), ...entry });
  saveTraffic(t);
}

// ============ 用户数据 ============
function loadUsers() {
  if (!fs.existsSync(USERS_FILE)) return { users: {}, nextId: 1 };
  return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
}
function saveUsers(data) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2));
}
function maskToken(t) {
  if (!t || t.length < 8) return '***';
  return t.slice(0, 6) + '...' + t.slice(-4);
}
function createUser(quota, label = '') {
  const data = loadUsers();
  const token = 'sk_' + require('crypto').randomBytes(20).toString('hex');
  const id = String(data.nextId++);
  data.users[id] = {
    token,
    quota,
    used: 0,
    created_at: new Date().toISOString(),
    label: label || `user_${id}`,
    active: true
  };
  saveUsers(data);
  writeLog({ type: 'user', action: 'create', user_id: id, quota, label });
  return { id, token, quota };
}

// ============ PayPal 辅助 ============
async function getPayPalToken() {
  if (!PAYPAL_CLIENT_ID || !PAYPAL_SECRET) return null;
  try {
    const res = await fetch(`${PAYPAL_API}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_SECRET}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: 'grant_type=client_credentials'
    });
    const data = await res.json();
    return data.access_token || null;
  } catch { return null; }
}

// ============ 路由 ============

// 支付配置
app.get('/api/payment-config', (req, res) => {
  res.json({
    paypal_enabled: !!(PAYPAL_CLIENT_ID && PAYPAL_SECRET),
    promptpay_enabled: !!PROMPT_PAY_PHONE,
    currency: 'THB'
  });
});

// 定价（双轨：套餐 + 按量）
app.get('/api/pricing', (req, res) => {
  const plans = {};
  for (const [key, p] of Object.entries(PRICING_PLANS)) {
    plans[key] = {
      name: p.name,
      name_th: p.name_th,
      description: p.description,
      amount_thb: p.amount_thb,
      quota: p.quota,
    };
  }
  res.json({
    model: 'qwen',
    currency: 'THB',
    min_amount: 50,
    tokens_per_baht_base: 9000,
    plans,
    tiers: getPricingTable()
  });
});

// ============ 免费试用 ============
app.post('/api/free-trial', (req, res) => {
  const rawIp = req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress || 'unknown';
  const ip = String(rawIp).split(',')[0].trim();
  const now = Date.now();

  // 24小时内每IP限领1次
  if (TRIAL_CLAIMS.has(ip)) {
    const last = TRIAL_CLAIMS.get(ip);
    if (now - last < TRIAL_WINDOW_MS) {
      const hrs = Math.ceil((TRIAL_WINDOW_MS - (now - last)) / 3_600_000);
      return res.status(429).json({
        error: `Free trial already claimed. Try again in ${hrs} hour(s).`,
        th: `เรียกใช้รุ่นทดลองฟรีแล้ว กรุณาลองอีกครั้งในอีก ${hrs} ชั่วโมง`
      });
    }
  }

  const user = createUser(TRIAL_QUOTA, `trial_${ip.replace(/[^a-zA-Z0-9]/g, '_')}`);
  TRIAL_CLAIMS.set(ip, now);
  writeLog({ type: 'trial', action: 'free_trial_claimed', user_id: user.id, ip });

  res.json({
    token: user.token,
    quota: TRIAL_QUOTA,
    user_id: user.id,
    message: 'Free trial activated! 10,000 tokens granted.',
    th: 'รุ่นทดลองฟรีเปิดใช้งานแล้ว! ได้รับ 10,000 tokens'
  });
});

// PayPal 创建订单（支持套餐 plan 或自定义金额 amount_thb）
app.post('/api/paypal/create-order', async (req, res) => {
  const { plan, amount_thb } = req.body;
  let quota, amount;

  if (plan && PRICING_PLANS[plan]) {
    quota = PRICING_PLANS[plan].quota;
    amount = PRICING_PLANS[plan].amount_thb;
  } else if (amount_thb) {
    const calc = calculateQuota(amount_thb);
    if (!calc) return res.status(400).json({ error: 'Invalid amount, min 100 THB' });
    quota = calc.quota;
    amount = calc.amount_thb;
  } else {
    return res.status(400).json({ error: 'Missing plan or amount_thb' });
  }

  try {
    const token = await getPayPalToken();
    if (!token) return res.status(500).json({ error: 'Failed to get PayPal token' });

    const returnUrl = `${req.protocol}://${req.get('host')}/return.html`;
    const cancelUrl = `${req.protocol}://${req.get('host')}/?cancel=1`;

    const orderRes = await fetch(`${PAYPAL_API}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        intent: 'CAPTURE',
        application_context: {
          brand_name: 'NovaGate',
          locale: 'en-US',
          landing_page: 'NO_PREFERENCE',
          user_action: 'PAY_NOW',
          return_url: returnUrl,
          cancel_url: cancelUrl
        },
        purchase_units: [{
          amount: {
            currency_code: 'THB',
            value: String(amount)
          },
          description: `NovaGate API Tokens - ${quota.toLocaleString()} tokens`,
          custom_id: JSON.stringify({ plan: plan || 'custom', quota, amount_thb: amount })
        }]
      })
    });

    const order = await orderRes.json();
    if (order.error) throw new Error(order.error.message);

    let approveUrl = '';
    if (order.links && Array.isArray(order.links)) {
      const approveLink = order.links.find(l => l.rel === 'approve');
      if (approveLink) approveUrl = approveLink.href;
    }

    writeLog({ type: 'payment', action: 'paypal_order_created', plan, amount_thb: amount, order_id: order.id });
    res.json({ order_id: order.id, approve_url: approveUrl, quota, amount_thb: amount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PayPal 确认付款（Capture）
app.post('/api/paypal/confirm', async (req, res) => {
  const { order_id, plan, amount_thb } = req.body;
  if (!order_id) return res.status(400).json({ error: 'Missing order_id' });

  try {
    const token = await getPayPalToken();
    if (!token) return res.status(500).json({ error: 'Failed to get PayPal token' });

    const orderRes = await fetch(`${PAYPAL_API}/v2/checkout/orders/${order_id}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const order = await orderRes.json();

    if (order.status !== 'COMPLETED' && order.status !== 'APPROVED') {
      return res.status(400).json({ error: `Order not completed: ${order.status}` });
    }

    let finalOrder = order;
    if (order.status === 'APPROVED') {
      const capRes = await fetch(`${PAYPAL_API}/v2/checkout/orders/${order_id}/capture`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      finalOrder = await capRes.json();
      if (finalOrder.error) throw new Error('Capture failed: ' + finalOrder.error.message);
    }

    // 确定 quota
    let quota;
    if (plan && PRICING_PLANS[plan]) {
      quota = PRICING_PLANS[plan].quota;
    } else if (amount_thb) {
      const calc = calculateQuota(amount_thb);
      quota = calc ? calc.quota : 1000000;
    } else {
      quota = 1000000;
    }

    const user = createUser(quota, `paypal_${order_id.slice(0, 8)}`);
    writeLog({ type: 'payment', action: 'paypal_confirmed', order_id, user_id: user.id, quota });
    res.json({ token: user.token, quota, user_id: user.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PromptPay 生成 QR
app.post('/api/promptpay/qr', (req, res) => {
  if (!PROMPT_PAY_PHONE) return res.status(503).json({ error: 'PromptPay not configured' });
  const { plan, amount_thb } = req.body;
  let quota, amount;

  if (plan && PRICING_PLANS[plan]) {
    quota = PRICING_PLANS[plan].quota;
    amount = PRICING_PLANS[plan].amount_thb;
  } else if (amount_thb) {
    const calc = calculateQuota(amount_thb);
    if (!calc) return res.status(400).json({ error: 'Invalid amount' });
    quota = calc.quota;
    amount = calc.amount_thb;
  } else {
    return res.status(400).json({ error: 'Missing plan or amount_thb' });
  }

  const qrUrl = `https://api.lorwongam.com/qr?phone=${PROMPT_PAY_PHONE}&amount=${amount}`;
  writeLog({ type: 'payment', action: 'promptpay_qr_generated', plan, amount_thb: amount });
  res.json({ qr_url: qrUrl, quota, amount_thb: amount, phone: PROMPT_PAY_PHONE });
});

// PromptPay 手动确认（管理员操作）
app.post('/api/promptpay/confirm', (req, res) => {
  const { admin_key, quota, label } = req.body;
  if (admin_key !== 'novagate-admin-2025') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const user = createUser(Number(quota) || 1000000, label || 'promptpay');
  writeLog({ type: 'payment', action: 'promptpay_confirmed', user_id: user.id, quota: user.quota });
  res.json({ token: user.token, quota: user.quota, user_id: user.id });
});

// ============ 核心代理端点 ============
app.post('/api/chat', async (req, res) => {
  const auth = req.headers['authorization'] || '';
  const m = auth.match(/Bearer\s+(sk_[a-f0-9]{40})/i);
  if (!m) return res.status(401).json({ error: 'Missing or invalid token' });

  const token = m[1];
  const data = loadUsers();
  let user = null, userId = null;
  for (const [id, u] of Object.entries(data.users)) {
    if (u.token === token) { user = u; userId = id; break; }
  }
  if (!user) return res.status(401).json({ error: 'Invalid token' });
  if (!user.active) return res.status(403).json({ error: 'Token disabled' });
  if (user.used >= user.quota) return res.status(403).json({ error: 'Quota exhausted' });

  if (!QWEN_API_KEY) {
    // 模拟模式
    const lastMsg = (req.body.messages && req.body.messages.length > 0) ? (req.body.messages[req.body.messages.length - 1].content || '') : ''; 
    const mock = { id: 'mock', choices: [{ message: { role: 'assistant', content: '[MOCK] You said: ' + lastMsg } }] };
    data.users[userId].used += 100;
    saveUsers(data);
    writeLog({ type: 'api', action: 'chat_mock', user_id: userId, tokens: 100 });
    return res.json(mock);
  }

  try {
    const proxyRes = await fetch(QWEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${QWEN_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(req.body)
    });
    const result = await proxyRes.json();

    // 粗略计算 token 消耗
    const promptTokens = req.body.messages?.reduce((s, m) => s + (m.content?.length || 0), 0) || 0;
    const completionTokens = (result.choices?.[0]?.message?.content?.length || 0);
    const totalTokens = Math.ceil((promptTokens + completionTokens) / 4) || 500;
    data.users[userId].used += totalTokens;
    saveUsers(data);
    writeLog({ type: 'api', action: 'chat', user_id: userId, tokens: totalTokens, model: req.body.model });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 清空日志
app.post('/admin/logs-reset', (req, res) => {
  saveLogs([]);
  res.json({ message: 'Logs cleared' });
});

// 管理员端点
app.get('/admin/users', (req, res) => {
  const data = loadUsers();
  const list = [];
  for (const [id, u] of Object.entries(data.users)) {
    list.push({
      id, label: u.label, token: maskToken(u.token),
      quota: u.quota, used: u.used,
      remaining: u.quota - u.used,
      created_at: u.created_at, active: u.active
    });
  }
  res.json({ total_users: list.length, users: list });
});

app.post('/admin/create-user', (req, res) => {
  const { quota, label } = req.body;
  const user = createUser(Number(quota) || 1000000, label || '');
  res.json({ token: user.token, quota: user.quota, user_id: user.id });
});

app.post('/admin/toggle-user', (req, res) => {
  const { user_id, active } = req.body;
  const data = loadUsers();
  if (!data.users[user_id]) return res.status(404).json({ error: 'Not found' });
  data.users[user_id].active = active !== false;
  saveUsers(data);
  res.json({ ok: true });
});

app.get('/admin/logs', (req, res) => {
  res.json(loadLogs().slice(-200));
});

// ============ 管理后台：统计数据 ============
app.get('/admin/stats', (req, res) => {
  const data = loadUsers();
  const users = Object.entries(data.users).map(([id, u]) => ({ id, ...u }));
  const totalUsers = users.length;
  const activeUsers = users.filter(u => u.active).length;
  const totalQuota = users.reduce((s, u) => s + u.quota, 0);
  const totalUsed = users.reduce((s, u) => s + u.used, 0);

  // 今日统计（基于 traffic.json）
  const traffic = loadTraffic();
  const today = new Date().toISOString().slice(0, 10); // "2026-06-13"
  const todayTraffic = traffic.filter(t => t.ts.startsWith(today));
  const todayRequests = todayTraffic.length;
  const todayErrors = todayTraffic.filter(t => t.status >= 400).length;
  const todayApiCalls = todayTraffic.filter(t => t.path === '/api/chat').length;

  // 今日 token 消耗（基于 logs.json）
  const logs = loadLogs();
  const todayLogs = logs.filter(l => l.timestamp && l.timestamp.startsWith(today));
  const todayTokens = todayLogs
    .filter(l => l.type === 'api' && l.action === 'chat')
    .reduce((s, l) => s + (l.tokens || 0), 0);

  // 按小时分布（最近24小时）
  const hourlyLabels = [];
  const hourlyData = [];
  const now = new Date();
  for (let h = 23; h >= 0; h--) {
    const d = new Date(now - h * 3600000);
    const label = d.toISOString().slice(11, 16); // "HH:MM"
    const hourPrefix = d.toISOString().slice(0, 13); // "2026-06-13T15"
    const count = traffic.filter(t => t.ts.startsWith(hourPrefix)).length;
    hourlyLabels.push(label);
    hourlyData.push(count);
  }

  // 每日 token 消耗趋势（最近14天）
  const dailyTokenLabels = [];
  const dailyTokenData = [];
  for (let d = 13; d >= 0; d--) {
    const date = new Date(now - d * 86400000);
    const dateStr = date.toISOString().slice(0, 10);
    const tokens = logs
      .filter(l => l.timestamp && l.timestamp.startsWith(dateStr) && l.type === 'api' && l.action === 'chat')
      .reduce((s, l) => s + (l.tokens || 0), 0);
    dailyTokenLabels.push(dateStr.slice(5)); // "06-13"
    dailyTokenData.push(tokens);
  }

  // Top 路径
  const pathCounts = {};
  traffic.forEach(t => { pathCounts[t.path] = (pathCounts[t.path] || 0) + 1; });
  const topPaths = Object.entries(pathCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([path, count]) => ({ path, count }));

  // 今日新注册
  const todayNewUsers = users.filter(u => u.created_at && u.created_at.startsWith(today)).length;

  // 营收统计
  const paymentLogs = logs.filter(l => l.type === 'payment' && l.action === 'paypal_confirmed');
  const totalRevenue = paymentLogs.length * 999; // 粗略估算，实际可从log中读取

  res.json({
    total_users: totalUsers,
    active_users: activeUsers,
    today_new_users: todayNewUsers,
    total_quota: totalQuota,
    total_used: totalUsed,
    usage_pct: totalQuota > 0 ? ((totalUsed / totalQuota) * 100).toFixed(1) : 0,
    today_requests: todayRequests,
    today_errors: todayErrors,
    today_api_calls: todayApiCalls,
    today_tokens: todayTokens,
    hourly: { labels: hourlyLabels, data: hourlyData },
    daily_tokens: { labels: dailyTokenLabels, data: dailyTokenData },
    top_paths: topPaths,
    payments_count: paymentLogs.length,
    traffic_count: traffic.length
  });
});

// 最近请求日志（最新 N 条）
app.get('/admin/recent', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const traffic = loadTraffic();
  res.json(traffic.slice(-limit).reverse());
});

// 启动
app.listen(PORT, () => {
  console.log(`NovaGate running on http://localhost:${PORT}`);
  console.log(`PayPal: ${PAYPAL_CLIENT_ID ? 'ENABLED' : 'DISABLED'}`);
  console.log(`PromptPay: ${PROMPT_PAY_PHONE ? 'ENABLED (' + PROMPT_PAY_PHONE + ')' : 'DISABLED'}`);
});
