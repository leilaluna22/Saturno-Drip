-- =====================================================================
--  Saturno Drip - Esquema de la base de datos (SQLite)
--  Se ejecuta automáticamente al iniciar el servidor (es idempotente).
--  Las fechas se guardan como milisegundos Unix (Date.now()).
--  Los precios se guardan como enteros en pesos argentinos.
-- =====================================================================

-- Clientes y administradores
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT    NOT NULL,
    email         TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT    NOT NULL,                       -- scrypt, nunca la clave en texto plano
    role          TEXT    NOT NULL DEFAULT 'customer' CHECK (role IN ('customer', 'admin')),
    created_at    INTEGER NOT NULL
);

-- Sesiones iniciadas (se guarda el hash del token, no el token)
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT    PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
);

-- Prendas. Cada prenda es única: o está disponible o está vendida.
-- reserved_* se usa mientras alguien está pagando (evita que dos personas paguen la misma prenda).
CREATE TABLE IF NOT EXISTS products (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    name               TEXT    NOT NULL,
    description        TEXT    NOT NULL DEFAULT '',
    price              INTEGER NOT NULL CHECK (price > 0),
    image              TEXT    NOT NULL DEFAULT '',
    status             TEXT    NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'sold')),
    reserved_order_id  INTEGER,
    reserved_until     INTEGER,
    created_at         INTEGER NOT NULL,
    sold_at            INTEGER
);

-- Carrito de cada usuario (una prenda solo puede estar una vez)
CREATE TABLE IF NOT EXISTS cart_items (
    user_id    INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    added_at   INTEGER NOT NULL,
    PRIMARY KEY (user_id, product_id)
);

-- Pedidos
--   pending   = esperando el pago (las prendas están reservadas)
--   paid      = pago aprobado, prendas marcadas como vendidas
--   cancelled = vencido, reemplazado o cancelado
--   conflict  = se aprobó un pago pero la prenda ya no estaba disponible (hay que devolver la plata)
CREATE TABLE IF NOT EXISTS orders (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id           INTEGER NOT NULL REFERENCES users(id),
    total             INTEGER NOT NULL,
    status            TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'cancelled', 'conflict')),
    created_at        INTEGER NOT NULL,
    expires_at        INTEGER NOT NULL,
    paid_at           INTEGER,
    mp_preference_id  TEXT,
    mp_payment_id     TEXT,
    note              TEXT
);

-- Prendas de cada pedido (se guarda nombre y precio al momento de la compra)
CREATE TABLE IF NOT EXISTS order_items (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id INTEGER NOT NULL REFERENCES products(id),
    name       TEXT    NOT NULL,
    price      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_orders_user    ON orders(user_id, status);
CREATE INDEX IF NOT EXISTS idx_items_order    ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_items_product  ON order_items(product_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user  ON sessions(user_id);


-- MODELO EXTENDIDO DE LA PROPUESTA (PDF, páginas 20-21).
-- Tablas complementarias; no reemplazan aún la lógica de prendas únicas.
CREATE TABLE IF NOT EXISTS categories (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 name TEXT NOT NULL UNIQUE,
 description TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS product_variants (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
 size TEXT NOT NULL,
 color TEXT NOT NULL,
 stock INTEGER NOT NULL DEFAULT 0 CHECK(stock >= 0),
 UNIQUE(product_id,size,color)
);
CREATE INDEX IF NOT EXISTS idx_product_variants_product ON product_variants(product_id);
CREATE TABLE IF NOT EXISTS order_variant_details (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
 variant_id INTEGER NOT NULL REFERENCES product_variants(id),
 quantity INTEGER NOT NULL CHECK(quantity > 0),
 unit_price INTEGER NOT NULL CHECK(unit_price >= 0),
 subtotal INTEGER NOT NULL CHECK(subtotal >= 0)
);
CREATE TABLE IF NOT EXISTS payments (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id),
 method TEXT NOT NULL CHECK(method IN ('mercado_pago','cash')),
 amount INTEGER NOT NULL CHECK(amount >= 0),
 status TEXT NOT NULL DEFAULT 'pending',
 paid_at INTEGER,
 external_id TEXT
);
