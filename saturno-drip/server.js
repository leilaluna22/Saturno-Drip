'use strict';
/**
 * Saturno Drip - Servidor
 * ------------------------------------------------------------------
 * Sin dependencias externas: solo módulos que ya trae Node.js (22.13 o superior).
 *   - Base de datos: SQLite (módulo node:sqlite) -> archivo data/saturno.db
 *   - Contraseñas: scrypt (nunca se guardan en texto plano)
 *   - Pagos: Mercado Pago Checkout Pro
 */

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { DatabaseSync } = require('node:sqlite');

const scrypt = promisify(crypto.scrypt);

// ---------------------------------------------------------------------
// Configuración (se lee del archivo .env)
// ---------------------------------------------------------------------
try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch (e) {
  if (e.code !== 'ENOENT') console.warn('No pude leer el archivo .env:', e.message);
}

const env = process.env;
const PORT = Number(env.PORT) || 3000;
const BASE_URL = (env.BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const IS_HTTPS = BASE_URL.startsWith('https://');
const IS_PROD = env.NODE_ENV === 'production';
const TRUST_PROXY = env.TRUST_PROXY === 'true';
const MP_TOKEN = (env.MP_ACCESS_TOKEN || '').trim();
const MP_API = (env.MP_API_URL || 'https://api.mercadopago.com').replace(/\/+$/, '');
const MP_WEBHOOK_SECRET = (env.MP_WEBHOOK_SECRET || '').trim();
const RESERVE_MINUTES = Number(env.RESERVE_MINUTES) || 20;
const ADMIN_EMAIL = (env.ADMIN_EMAIL || '').trim().toLowerCase();
const ADMIN_PASSWORD = env.ADMIN_PASSWORD || '';

const DATA_DIR = path.resolve(env.DATA_DIR || path.join(__dirname, 'data'));
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');

const SESSION_DAYS = 30;
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------
// Base de datos
// ---------------------------------------------------------------------
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'saturno.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
db.exec(fs.readFileSync(path.join(__dirname, 'database', 'schema.sql'), 'utf8'));

/** Ejecuta fn dentro de una transacción: o se guarda todo o no se guarda nada. */
function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Prendas de ejemplo (solo la primera vez que se crea la base)
if (db.prepare('PRAGMA user_version').get().user_version === 0) {
  const ins = db.prepare('INSERT INTO products (name, description, price, image, created_at) VALUES (?, ?, ?, ?, ?)');
  const now = Date.now();
  ins.run('Remera polo', 'Tela elástica, corta, blanca.', 25000, '/img/prod1.png', now);
  ins.run("Vestido 2000's", 'Vestido corto retro.', 30000, '/img/prod2.png', now);
  ins.run('Remera Polo mangas largas', 'Remera blanca con cuello y mangas largas.', 30000, '/img/prod3.png', now);
  db.exec('PRAGMA user_version = 1');
}

// ---------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------
class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  try {
    const [alg, saltHex, hashHex] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const expected = Buffer.from(hashHex, 'hex');
    const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// Hash de relleno para que el login tarde igual si el email no existe
let DUMMY_HASH = null;
hashPassword(crypto.randomBytes(8).toString('hex')).then((h) => (DUMMY_HASH = h));

/** Fecha en formato que pide Mercado Pago (hora de Argentina, UTC-3). */
function mpDate(ms) {
  return new Date(ms - 3 * 60 * 60 * 1000).toISOString().replace('Z', '-03:00');
}

// Límite de intentos (anti fuerza bruta)
const attempts = new Map();
function isBlocked(key, max) {
  const a = attempts.get(key);
  return !!a && a.reset > Date.now() && a.count >= max;
}
function addFail(key, windowMs) {
  const now = Date.now();
  let a = attempts.get(key);
  if (!a || a.reset < now) a = { count: 0, reset: now + windowMs };
  a.count++;
  attempts.set(key, a);
}
setInterval(() => {
  const now = Date.now();
  for (const [k, a] of attempts) if (a.reset < now) attempts.delete(k);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
}, 10 * 60 * 1000).unref();

// ---------------------------------------------------------------------
// Usuarios y sesiones
// ---------------------------------------------------------------------
const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role });

function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(sha256(token), userId, Date.now() + SESSION_MS);
  setSessionCookie(res, token, SESSION_MS / 1000);
}

function setSessionCookie(res, value, maxAgeSeconds) {
  const parts = [`sid=${value}`, 'HttpOnly', 'SameSite=Lax', 'Path=/', `Max-Age=${Math.floor(maxAgeSeconds)}`];
  if (IS_HTTPS) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignorar */ }
    }
  }
  return out;
}

function getUserFromRequest(req) {
  const token = parseCookies(req).sid;
  if (!token) return null;
  return db.prepare(`
    SELECT u.id, u.name, u.email, u.role
      FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`).get(sha256(token), Date.now()) || null;
}

/** Crea (o actualiza) el usuario administrador con los datos del .env */
async function ensureAdmin() {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    console.warn('⚠  Falta ADMIN_EMAIL / ADMIN_PASSWORD en el .env: no se creó ningún administrador.');
    return;
  }
  const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(ADMIN_EMAIL);
  if (!existing) {
    db.prepare('INSERT INTO users (name, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('Administrador', ADMIN_EMAIL, await hashPassword(ADMIN_PASSWORD), 'admin', Date.now());
    console.log(`✔ Administrador creado: ${ADMIN_EMAIL}`);
    return;
  }
  // El .env manda: si cambiaste la contraseña ahí, se actualiza al reiniciar
  if (!(await verifyPassword(ADMIN_PASSWORD, existing.password_hash))) {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(ADMIN_PASSWORD), existing.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(existing.id);
    console.log('✔ Contraseña del administrador actualizada desde el .env');
  }
  if (existing.role !== 'admin') db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(existing.id);
}

// ---------------------------------------------------------------------
// Stock, reservas y pedidos
// ---------------------------------------------------------------------
const isReserved = (p, now) => !!p.reserved_until && p.reserved_until > now;

/** Estado de una prenda desde el punto de vista de un usuario: available | reserved | sold */
function stateFor(p, userId, now = Date.now()) {
  if (p.status === 'sold') return 'sold';
  if (isReserved(p, now) && p.reserved_user !== userId) return 'reserved';
  return 'available';
}

function cancelOrder(orderId, note) {
  db.prepare("UPDATE orders SET status = 'cancelled', note = ? WHERE id = ? AND status = 'pending'").run(note, orderId);
  db.prepare('UPDATE products SET reserved_order_id = NULL, reserved_until = NULL WHERE reserved_order_id = ?').run(orderId);
}

function cancelPendingOrdersWithProduct(productId, exceptOrderId, note) {
  const rows = db.prepare(`
    SELECT DISTINCT o.id FROM order_items oi JOIN orders o ON o.id = oi.order_id
     WHERE oi.product_id = ? AND o.status = 'pending' AND o.id != ?`).all(productId, exceptOrderId || 0);
  for (const r of rows) cancelOrder(r.id, note);
}

/** Libera las reservas vencidas (pagos que nunca se completaron). */
function releaseExpired() {
  const now = Date.now();
  tx(() => {
    const expired = db.prepare("SELECT id FROM orders WHERE status = 'pending' AND expires_at < ?").all(now);
    for (const o of expired) cancelOrder(o.id, 'Venció el tiempo para pagar');
    db.prepare('UPDATE products SET reserved_order_id = NULL, reserved_until = NULL WHERE reserved_until IS NOT NULL AND reserved_until < ?').run(now);
  });
}
setInterval(() => { try { releaseExpired(); } catch (e) { console.error(e); } }, 60 * 1000).unref();

/**
 * Se llama cuando un pago fue APROBADO. Marca las prendas como vendidas.
 * Es seguro llamarla varias veces (si ya estaba paga no hace nada).
 */
function fulfillOrder(orderId, paymentId) {
  return tx(() => {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!order) return null;
    if (order.status === 'paid' || order.status === 'conflict') return order.status;

    const items = db.prepare('SELECT product_id FROM order_items WHERE order_id = ?').all(orderId);
    const now = Date.now();
    const unavailable = items.some((it) => {
      const p = db.prepare('SELECT status FROM products WHERE id = ?').get(it.product_id);
      return !p || p.status === 'sold';
    });

    if (unavailable) {
      db.prepare("UPDATE orders SET status = 'conflict', mp_payment_id = ?, paid_at = ?, note = ? WHERE id = ?")
        .run(String(paymentId), now,
          'El pago fue aprobado pero alguna prenda ya no estaba disponible. Hay que devolver el dinero desde Mercado Pago.', orderId);
      db.prepare('UPDATE products SET reserved_order_id = NULL, reserved_until = NULL WHERE reserved_order_id = ?').run(orderId);
      return 'conflict';
    }

    for (const it of items) {
      db.prepare("UPDATE products SET status = 'sold', sold_at = ?, reserved_order_id = NULL, reserved_until = NULL WHERE id = ?")
        .run(now, it.product_id);
      db.prepare('DELETE FROM cart_items WHERE product_id = ?').run(it.product_id);
      cancelPendingOrdersWithProduct(it.product_id, orderId, 'La prenda se vendió en otro pedido');
    }
    db.prepare("UPDATE orders SET status = 'paid', paid_at = ?, mp_payment_id = ?, note = NULL WHERE id = ?")
      .run(now, String(paymentId), orderId);
    return 'paid';
  });
}

function setProductStatus(id, status) {
  tx(() => {
    if (status === 'sold') {
      db.prepare("UPDATE products SET status = 'sold', sold_at = ?, reserved_order_id = NULL, reserved_until = NULL WHERE id = ?").run(Date.now(), id);
      db.prepare('DELETE FROM cart_items WHERE product_id = ?').run(id);
    } else {
      db.prepare("UPDATE products SET status = 'available', sold_at = NULL, reserved_order_id = NULL, reserved_until = NULL WHERE id = ?").run(id);
    }
    cancelPendingOrdersWithProduct(id, 0, 'El administrador cambió el stock de la prenda');
  });
}

// ---------------------------------------------------------------------
// Mercado Pago
// ---------------------------------------------------------------------
async function mpRequest(method, pathname, body) {
  const res = await fetch(MP_API + pathname, {
    method,
    headers: { Authorization: `Bearer ${MP_TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`Mercado Pago respondió ${res.status}: ${text.slice(0, 400)}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function createPreference(order, items) {
  const body = {
    items: items.map((p) => ({
      id: String(p.id), title: p.name, quantity: 1, unit_price: p.price, currency_id: 'ARS',
    })),
    external_reference: String(order.id),
    statement_descriptor: 'SATURNO DRIP',
    back_urls: {
      success: `${BASE_URL}/pago-resultado.html`,
      failure: `${BASE_URL}/pago-resultado.html`,
      pending: `${BASE_URL}/pago-resultado.html`,
    },
    expires: true,
    expiration_date_from: mpDate(Date.now()),
    expiration_date_to: mpDate(order.expires_at),
    // Solo medios de pago inmediatos: así la prenda no queda reservada días esperando un pago en efectivo
    payment_methods: { excluded_payment_types: [{ id: 'ticket' }, { id: 'atm' }] },
  };
  // Mercado Pago solo acepta estas dos opciones con direcciones públicas (https)
  if (IS_HTTPS) {
    body.auto_return = 'approved';
    body.notification_url = `${BASE_URL}/api/mp/webhook`;
  }
  return mpRequest('POST', '/checkout/preferences', body);
}

/** Procesa un pago de Mercado Pago (ya consultado a su API, no confiamos en lo que manda el navegador). */
function applyPayment(payment, expectedOrderId = null) {
  const orderId = Number(payment.external_reference);
  if (!Number.isInteger(orderId)) return null;
  if (expectedOrderId && orderId !== expectedOrderId) return null;
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return null;

  if (payment.status === 'approved') {
    const amountOk = payment.currency_id === 'ARS' &&
      Math.round(Number(payment.transaction_amount) * 100) === order.total * 100;
    if (!amountOk) {
      db.prepare("UPDATE orders SET note = ? WHERE id = ? AND status != 'paid'")
        .run(`Pago ${payment.id} aprobado pero el monto no coincide (${payment.transaction_amount} ${payment.currency_id}). Revisar a mano.`, orderId);
      return null;
    }
    return fulfillOrder(orderId, payment.id);
  }
  return order.status;
}

async function syncPayment(paymentId, expectedOrderId = null) {
  const payment = await mpRequest('GET', `/v1/payments/${encodeURIComponent(paymentId)}`);
  return applyPayment(payment, expectedOrderId);
}

async function syncByReference(orderId) {
  const r = await mpRequest('GET',
    `/v1/payments/search?external_reference=${orderId}&sort=date_created&criteria=desc&limit=10`);
  for (const payment of r.results || []) {
    if (payment.status === 'approved') return applyPayment(payment, orderId);
  }
  return null;
}

function verifyWebhookSignature(req, url) {
  if (!MP_WEBHOOK_SECRET) return true;
  const sig = req.headers['x-signature'];
  const requestId = req.headers['x-request-id'];
  if (!sig || !requestId) return false;
  const parts = {};
  for (const piece of String(sig).split(',')) {
    const [k, v] = piece.trim().split('=');
    parts[k] = v;
  }
  if (!parts.ts || !parts.v1) return false;
  const dataId = url.searchParams.get('data.id');
  let manifest = '';
  if (dataId) manifest += `id:${String(dataId).toLowerCase()};`;
  manifest += `request-id:${requestId};ts:${parts.ts};`;
  const expected = crypto.createHmac('sha256', MP_WEBHOOK_SECRET).update(manifest).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(parts.v1);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------
// Lectura de datos enviados por el navegador
// ---------------------------------------------------------------------
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) tooBig = true;
      else chunks.push(c);
    });
    req.on('end', () => (tooBig ? reject(new HttpError(413, 'El archivo o los datos son demasiado grandes')) : resolve(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req, 100 * 1024);
  if (!buf.length) return {};
  try {
    const v = JSON.parse(buf.toString('utf8'));
    return v && typeof v === 'object' ? v : {};
  } catch {
    throw new HttpError(400, 'Los datos enviados no son válidos');
  }
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

const toId = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'Identificador inválido');
  return n;
};

// ---------------------------------------------------------------------
// Rutas de la API
// ---------------------------------------------------------------------
const routes = [];
function route(method, pattern, handler, auth = null) {
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$');
  routes.push({ method, re, handler, auth });
}

// ---- Cuenta ----------------------------------------------------------
route('GET', '/api/me', (ctx) => {
  const cartCount = ctx.user
    ? db.prepare('SELECT COUNT(*) AS n FROM cart_items WHERE user_id = ?').get(ctx.user.id).n
    : 0;
  return { user: ctx.user ? publicUser(ctx.user) : null, cartCount };
});

route('POST', '/api/register', async (ctx) => {
  const key = `reg:${ctx.ip}`;
  if (isBlocked(key, 10)) throw new HttpError(429, 'Demasiados registros desde tu conexión. Probá más tarde.');
  addFail(key, 60 * 60 * 1000);

  const b = await readJson(ctx.req);
  const name = String(b.name || '').trim();
  const email = String(b.email || '').trim().toLowerCase();
  const password = String(b.password || '');

  if (name.length < 2 || name.length > 60) throw new HttpError(400, 'Ingresá tu nombre (entre 2 y 60 caracteres).');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 120) throw new HttpError(400, 'Ingresá un email válido.');
  if (password.length < 8 || password.length > 100) throw new HttpError(400, 'La contraseña debe tener al menos 8 caracteres.');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new HttpError(409, 'Ya existe una cuenta con ese email.');

  // El rol SIEMPRE es "customer": nadie puede hacerse admin desde el registro
  const info = db.prepare('INSERT INTO users (name, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(name, email, await hashPassword(password), 'customer', Date.now());
  createSession(ctx.res, info.lastInsertRowid);
  return { user: { id: Number(info.lastInsertRowid), name, email, role: 'customer' } };
});

route('POST', '/api/login', async (ctx) => {
  const b = await readJson(ctx.req);
  const email = String(b.email || '').trim().toLowerCase();
  const password = String(b.password || '');
  const key = `login:${ctx.ip}:${email}`;
  if (isBlocked(key, 8)) throw new HttpError(429, 'Demasiados intentos. Esperá unos minutos y probá de nuevo.');

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  const ok = await verifyPassword(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !ok) {
    addFail(key, 15 * 60 * 1000);
    throw new HttpError(401, 'Email o contraseña incorrectos.');
  }
  attempts.delete(key);
  createSession(ctx.res, user.id);
  return { user: publicUser(user) };
});

route('POST', '/api/logout', (ctx) => {
  const token = parseCookies(ctx.req).sid;
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  setSessionCookie(ctx.res, '', 0);
  return { ok: true };
});

// ---- Catálogo --------------------------------------------------------
route('GET', '/api/products', (ctx) => {
  releaseExpired();
  const uid = ctx.user ? ctx.user.id : 0;
  const now = Date.now();
  const rows = db.prepare(`
    SELECT p.*, o.user_id AS reserved_user
      FROM products p LEFT JOIN orders o ON o.id = p.reserved_order_id
     ORDER BY (p.status = 'sold'), p.id DESC`).all();
  const inCart = new Set(
    uid ? db.prepare('SELECT product_id FROM cart_items WHERE user_id = ?').all(uid).map((r) => r.product_id) : []);
  return {
    products: rows.map((p) => ({
      id: p.id, name: p.name, description: p.description, price: p.price, image: p.image,
      state: stateFor(p, uid, now), inCart: inCart.has(p.id),
    })),
  };
});

// ---- Carrito ---------------------------------------------------------
function loadCart(userId) {
  const now = Date.now();
  const rows = db.prepare(`
    SELECT p.*, o.user_id AS reserved_user
      FROM cart_items c
      JOIN products p ON p.id = c.product_id
      LEFT JOIN orders o ON o.id = p.reserved_order_id
     WHERE c.user_id = ? ORDER BY c.added_at`).all(userId);
  const items = rows.map((p) => ({
    id: p.id, name: p.name, description: p.description, price: p.price, image: p.image,
    state: stateFor(p, userId, now),
  }));
  const total = items.filter((i) => i.state === 'available').reduce((s, i) => s + i.price, 0);
  return { items, total, hasUnavailable: items.some((i) => i.state !== 'available') };
}

route('GET', '/api/cart', (ctx) => {
  releaseExpired();
  return loadCart(ctx.user.id);
}, 'user');

route('POST', '/api/cart', async (ctx) => {
  releaseExpired();
  const b = await readJson(ctx.req);
  const productId = toId(b.productId);
  const p = db.prepare(`
    SELECT p.*, o.user_id AS reserved_user FROM products p
      LEFT JOIN orders o ON o.id = p.reserved_order_id WHERE p.id = ?`).get(productId);
  if (!p) throw new HttpError(404, 'Esa prenda no existe.');
  const state = stateFor(p, ctx.user.id);
  if (state === 'sold') throw new HttpError(409, 'Esta prenda ya se agotó.');
  if (state === 'reserved') throw new HttpError(409, 'Esta prenda está reservada por otra persona que está pagando. Si no completa el pago, vuelve a estar disponible.');
  db.prepare('INSERT OR IGNORE INTO cart_items (user_id, product_id, added_at) VALUES (?, ?, ?)').run(ctx.user.id, productId, Date.now());
  return { cartCount: db.prepare('SELECT COUNT(*) AS n FROM cart_items WHERE user_id = ?').get(ctx.user.id).n };
}, 'user');

route('DELETE', '/api/cart/:productId', (ctx) => {
  db.prepare('DELETE FROM cart_items WHERE user_id = ? AND product_id = ?').run(ctx.user.id, toId(ctx.params.productId));
  return loadCart(ctx.user.id);
}, 'user');

// ---- Pago ------------------------------------------------------------
route('POST', '/api/checkout', async (ctx) => {
  releaseExpired();
  const uid = ctx.user.id;
  const now = Date.now();

  // 1) Reservar las prendas y crear el pedido (todo o nada)
  const order = tx(() => {
    const previous = db.prepare("SELECT id FROM orders WHERE user_id = ? AND status = 'pending'").all(uid);
    for (const o of previous) cancelOrder(o.id, 'Reemplazado por un nuevo intento de pago');

    const items = db.prepare(`
      SELECT p.*, o.user_id AS reserved_user
        FROM cart_items c JOIN products p ON p.id = c.product_id
        LEFT JOIN orders o ON o.id = p.reserved_order_id
       WHERE c.user_id = ? ORDER BY c.added_at`).all(uid);
    if (!items.length) throw new HttpError(400, 'Tu carrito está vacío.');

    const bad = items.filter((p) => stateFor(p, uid, now) !== 'available');
    if (bad.length) {
      throw new HttpError(409, 'Algunas prendas de tu carrito ya no están disponibles. Quitalas para continuar.',
        { unavailable: bad.map((p) => p.id) });
    }

    const total = items.reduce((s, p) => s + p.price, 0);
    const expiresAt = now + RESERVE_MINUTES * 60 * 1000;
    const info = db.prepare('INSERT INTO orders (user_id, total, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(uid, total, 'pending', now, expiresAt);
    const orderId = Number(info.lastInsertRowid);
    for (const p of items) {
      db.prepare('INSERT INTO order_items (order_id, product_id, name, price) VALUES (?, ?, ?, ?)').run(orderId, p.id, p.name, p.price);
      db.prepare('UPDATE products SET reserved_order_id = ?, reserved_until = ? WHERE id = ?').run(orderId, expiresAt, p.id);
    }
    return { id: orderId, total, expires_at: expiresAt, items };
  });

  // 2) Crear el pago en Mercado Pago
  if (!MP_TOKEN) {
    if (IS_PROD) {
      cancelOrder(order.id, 'Mercado Pago no está configurado');
      throw new HttpError(503, 'El pago online no está disponible por el momento.');
    }
    return { url: `/pago-demo.html?order=${order.id}` }; // modo de prueba local
  }
  try {
    const pref = await createPreference(order, order.items);
    db.prepare('UPDATE orders SET mp_preference_id = ? WHERE id = ?').run(String(pref.id), order.id);
    return { url: pref.init_point };
  } catch (err) {
    console.error('Error al crear la preferencia de pago:', err.message);
    tx(() => cancelOrder(order.id, 'No se pudo iniciar el pago'));
    throw new HttpError(502, 'No pudimos iniciar el pago con Mercado Pago. Probá de nuevo en unos minutos.');
  }
}, 'user');

route('GET', '/api/orders/:id/verify', async (ctx) => {
  const id = toId(ctx.params.id);
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!order || (order.user_id !== ctx.user.id && ctx.user.role !== 'admin')) throw new HttpError(404, 'Pedido no encontrado.');

  if (MP_TOKEN && (order.status === 'pending' || order.status === 'cancelled')) {
    try {
      const pid = ctx.query.payment_id;
      if (pid && /^\d{1,20}$/.test(pid)) await syncPayment(pid, id);
      else await syncByReference(id);
    } catch (err) {
      console.error('No pude verificar el pago en Mercado Pago:', err.message);
    }
  }
  const fresh = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  const items = db.prepare('SELECT name, price FROM order_items WHERE order_id = ?').all(id);
  return { orderId: id, status: fresh.status, total: fresh.total, items };
}, 'user');

// Mercado Pago avisa acá cuando cambia el estado de un pago
route('POST', '/api/mp/webhook', async (ctx) => {
  if (!MP_TOKEN) return { ok: true };
  if (!verifyWebhookSignature(ctx.req, ctx.url)) throw new HttpError(401, 'Firma inválida');
  let body = {};
  try { body = await readJson(ctx.req); } catch { /* algunas notificaciones vienen sin cuerpo */ }
  const q = ctx.query;
  const type = body.type || q.type || q.topic;
  const id = (body.data && body.data.id) || q['data.id'] || (q.topic === 'payment' ? q.id : null);
  if (type === 'payment' && id && /^\d{1,20}$/.test(String(id))) {
    try {
      await syncPayment(String(id));
    } catch (err) {
      console.error('Webhook: error al procesar el pago', id, err.message);
      throw new HttpError(500, 'Error al procesar el pago'); // MP reintenta más tarde
    }
  }
  return { ok: true };
});

// Solo para probar sin Mercado Pago (no existe si hay token o en producción)
route('POST', '/api/demo/pay', async (ctx) => {
  if (MP_TOKEN || IS_PROD) throw new HttpError(404, 'No encontrado');
  const b = await readJson(ctx.req);
  const id = toId(b.orderId);
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(id, ctx.user.id);
  if (!order || order.status !== 'pending') throw new HttpError(400, 'Este pedido ya no está pendiente.');
  if (b.result === 'approved') fulfillOrder(id, `DEMO-${id}`);
  return { status: b.result === 'approved' ? 'approved' : 'rejected' };
}, 'user');

// ---- Administración --------------------------------------------------
function validateProduct(b) {
  const name = String(b.name || '').trim();
  const description = String(b.description || '').trim();
  const price = Number(b.price);
  const image = String(b.image || '').trim();
  if (name.length < 2 || name.length > 80) throw new HttpError(400, 'El nombre debe tener entre 2 y 80 caracteres.');
  if (description.length > 300) throw new HttpError(400, 'La descripción puede tener hasta 300 caracteres.');
  if (!Number.isInteger(price) || price < 1 || price > 10000000) throw new HttpError(400, 'El precio debe ser un número entero mayor a 0.');
  if (image && !/^\/(img|uploads)\/[\w.-]+$/.test(image)) throw new HttpError(400, 'La imagen no es válida.');
  return { name, description, price, image };
}

route('GET', '/api/admin/products', () => {
  releaseExpired();
  const now = Date.now();
  const rows = db.prepare(`
    SELECT p.*, u.name AS reserved_by
      FROM products p
      LEFT JOIN orders o ON o.id = p.reserved_order_id
      LEFT JOIN users u ON u.id = o.user_id
     ORDER BY p.id DESC`).all();
  return {
    products: rows.map((p) => ({
      id: p.id, name: p.name, description: p.description, price: p.price, image: p.image,
      state: p.status === 'sold' ? 'sold' : isReserved(p, now) ? 'reserved' : 'available',
      reservedUntil: isReserved(p, now) ? p.reserved_until : null,
      reservedBy: isReserved(p, now) ? p.reserved_by : null,
      soldAt: p.sold_at,
    })),
  };
}, 'admin');

route('POST', '/api/admin/products', async (ctx) => {
  const v = validateProduct(await readJson(ctx.req));
  const info = db.prepare('INSERT INTO products (name, description, price, image, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(v.name, v.description, v.price, v.image, Date.now());
  return { id: Number(info.lastInsertRowid) };
}, 'admin');

route('PUT', '/api/admin/products/:id', async (ctx) => {
  const id = toId(ctx.params.id);
  const v = validateProduct(await readJson(ctx.req));
  const r = db.prepare('UPDATE products SET name = ?, description = ?, price = ?, image = ? WHERE id = ?')
    .run(v.name, v.description, v.price, v.image, id);
  if (!r.changes) throw new HttpError(404, 'Prenda no encontrada.');
  return { ok: true };
}, 'admin');

route('POST', '/api/admin/products/:id/status', async (ctx) => {
  const id = toId(ctx.params.id);
  const b = await readJson(ctx.req);
  if (!['available', 'sold'].includes(b.status)) throw new HttpError(400, 'Estado inválido.');
  if (!db.prepare('SELECT 1 FROM products WHERE id = ?').get(id)) throw new HttpError(404, 'Prenda no encontrada.');
  setProductStatus(id, b.status);
  return { ok: true };
}, 'admin');

route('DELETE', '/api/admin/products/:id', (ctx) => {
  const id = toId(ctx.params.id);
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  if (!p) throw new HttpError(404, 'Prenda no encontrada.');
  if (db.prepare('SELECT 1 FROM order_items WHERE product_id = ?').get(id)) {
    throw new HttpError(409, 'Esta prenda tiene pedidos asociados y no se puede borrar. Marcala como agotada.');
  }
  tx(() => {
    cancelPendingOrdersWithProduct(id, 0, 'La prenda fue eliminada');
    db.prepare('DELETE FROM products WHERE id = ?').run(id);
  });
  // Borrar la foto subida si ya nadie la usa
  const m = /^\/uploads\/([a-f0-9]{32}\.(png|jpg|webp))$/.exec(p.image);
  if (m && !db.prepare('SELECT 1 FROM products WHERE image = ?').get(p.image)) {
    fsp.unlink(path.join(UPLOAD_DIR, m[1])).catch(() => {});
  }
  return { ok: true };
}, 'admin');

route('POST', '/api/admin/upload', async (ctx) => {
  const type = String(ctx.req.headers['content-type'] || '').split(';')[0].trim();
  const exts = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
  if (!exts[type]) throw new HttpError(400, 'Subí una imagen PNG, JPG o WEBP.');
  const buf = await readBody(ctx.req, 5 * 1024 * 1024);
  const isPng = buf.length > 8 && buf.subarray(0, 4).toString('hex') === '89504e47';
  const isJpg = buf.length > 3 && buf.subarray(0, 3).toString('hex') === 'ffd8ff';
  const isWebp = buf.length > 12 && buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP';
  if (!(isPng || isJpg || isWebp)) throw new HttpError(400, 'El archivo no es una imagen válida.');
  const ext = isPng ? 'png' : isJpg ? 'jpg' : 'webp';
  const name = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
  await fsp.writeFile(path.join(UPLOAD_DIR, name), buf);
  return { url: `/uploads/${name}` };
}, 'admin');

route('GET', '/api/admin/orders', () => {
  const orders = db.prepare(`
    SELECT o.*, u.name AS user_name, u.email AS user_email
      FROM orders o JOIN users u ON u.id = o.user_id
     ORDER BY o.id DESC LIMIT 200`).all();
  const itemsStmt = db.prepare('SELECT name, price FROM order_items WHERE order_id = ?');
  return {
    orders: orders.map((o) => ({
      id: o.id, status: o.status, total: o.total, createdAt: o.created_at, paidAt: o.paid_at,
      expiresAt: o.expires_at, paymentId: o.mp_payment_id, note: o.note,
      customer: { name: o.user_name, email: o.user_email },
      items: itemsStmt.all(o.id),
    })),
  };
}, 'admin');

// ---------------------------------------------------------------------
// Archivos estáticos (la carpeta /public)
// ---------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json',
};
// Estos archivos solo se le entregan al administrador
const ADMIN_ONLY = new Set(['/admin.html', '/admin.js']);

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<!DOCTYPE html><meta charset="utf-8"><title>No encontrado</title><body style="font-family:Arial;text-align:center;padding:80px"><h1>404</h1><p>No encontramos esa página.</p><a href="/">Volver al inicio</a>');
}

async function serveStatic(req, res, url, user) {
  let p;
  try { p = decodeURIComponent(url.pathname); } catch { return notFound(res); }
  if (p.includes('\0') || /(^|\/)\./.test(p)) return notFound(res);
  if (p === '/') p = '/index.html';

  let file;
  let cache = 'no-cache';
  if (p.startsWith('/uploads/')) {
    const name = p.slice('/uploads/'.length);
    if (!/^[a-f0-9]{32}\.(png|jpg|webp)$/.test(name)) return notFound(res);
    file = path.join(UPLOAD_DIR, name);
    cache = 'public, max-age=31536000, immutable';
  } else {
    if (ADMIN_ONLY.has(p) && !(user && user.role === 'admin')) {
      res.writeHead(302, { Location: user ? '/' : `/login.html?next=${encodeURIComponent(p)}` });
      return res.end();
    }
    file = path.join(PUBLIC_DIR, p);
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return notFound(res);
  }

  try {
    const data = await fsp.readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': ADMIN_ONLY.has(p) ? 'no-store' : cache,
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch {
    notFound(res);
  }
}

// ---------------------------------------------------------------------
// Servidor HTTP
// ---------------------------------------------------------------------
function clientIp(req) {
  if (TRUST_PROXY && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

async function handleApi(req, res, url, user) {
  const isWebhook = url.pathname === '/api/mp/webhook';

  if (req.method !== 'GET' && req.method !== 'HEAD' && !isWebhook) {
    // Protección CSRF: solo se aceptan pedidos JSON (o imágenes) hechos desde nuestro propio sitio
    const ct = String(req.headers['content-type'] || '');
    if (!ct.startsWith('application/json') && !ct.startsWith('image/')) throw new HttpError(415, 'Tipo de contenido no permitido');
    if (req.headers.origin) {
      let originHost = '';
      try { originHost = new URL(req.headers.origin).host; } catch { /* inválido */ }
      if (originHost !== req.headers.host) throw new HttpError(403, 'Origen no permitido');
    }
  }

  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = r.re.exec(url.pathname);
    if (!m) continue;
    if (r.auth && !user) throw new HttpError(401, 'Tenés que iniciar sesión.');
    if (r.auth === 'admin' && user.role !== 'admin') throw new HttpError(403, 'No tenés permisos para hacer esto.');
    const ctx = {
      req, res, url, user, ip: clientIp(req),
      params: m.groups || {}, query: Object.fromEntries(url.searchParams),
    };
    const result = await r.handler(ctx);
    return sendJson(res, 200, result === undefined ? { ok: true } : result);
  }
  throw new HttpError(404, 'No encontrado');
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; " +
    "frame-ancestors 'none'; form-action 'self'; base-uri 'self'");

  try {
    const url = new URL(req.url, 'http://localhost');
    const user = getUserFromRequest(req);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url, user);
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Método no permitido');
    return await serveStatic(req, res, url, user);
  } catch (err) {
    if (res.headersSent) return res.end();
    if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message, ...err.extra });
    console.error(err);
    return sendJson(res, 500, { error: 'Ocurrió un error en el servidor. Probá de nuevo.' });
  }
});

ensureAdmin().then(() => {
  releaseExpired();
  server.listen(PORT, () => {
    console.log(`\n🪐 Saturno Drip funcionando en ${BASE_URL}`);
    console.log(MP_TOKEN
      ? '💳 Mercado Pago: configurado'
      : '💳 Mercado Pago: SIN configurar (modo de prueba local: los pagos son simulados)');
    if (MP_TOKEN && !IS_HTTPS) {
      console.log('   ℹ Con BASE_URL sin https Mercado Pago no puede avisar automáticamente; el sitio verifica el pago cuando el cliente vuelve a la tienda.');
    }
    console.log('');
  });
});
