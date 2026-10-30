# Saturno Drip – Tienda online

Catálogo de prendas **únicas** con registro/login, carrito, pago con Mercado Pago y panel de administración para controlar el stock.

## 1. Cómo ponerlo a funcionar en tu compu

1. Instalá **Node.js 22.13 o superior** (versión LTS) desde https://nodejs.org
2. Abrí una terminal dentro de esta carpeta.
3. Copiá `.env.example` con el nombre `.env` y completá:
   - `ADMIN_EMAIL` y `ADMIN_PASSWORD` → con esos datos vas a entrar como administrador.
4. Ejecutá:
   ```
   npm start
   ```
   (no hace falta `npm install`: no usa librerías externas)
5. Abrí http://localhost:3000

Sin token de Mercado Pago la tienda funciona en **modo de prueba**: al "ir a pagar" aparece una pantalla para simular un pago aprobado o rechazado, así podés probar todo el flujo sin cobrar nada.

## 2. Cómo funciona

| Quién | Qué puede hacer |
|---|---|
| Visitante | Ver el catálogo |
| Cliente (se registra desde la web) | Agregar prendas al carrito, quitarlas y pagar |
| Administrador (el del `.env`) | Todo lo anterior + panel `/admin.html`: crear/editar/eliminar prendas, subir fotos, marcar agotada o disponible a mano, liberar reservas y ver pedidos |

- **Prendas únicas:** al aprobarse el pago, la prenda pasa a *Agotada* automáticamente y se saca de todos los carritos.
- **Reserva al pagar:** cuando alguien toca "Ir a pagar", sus prendas quedan reservadas `RESERVE_MINUTES` (20 por defecto). Si no paga, vuelven solas a estar disponibles. Así dos personas no pagan la misma prenda.
- **Seguridad:** las contraseñas se guardan con scrypt (no se pueden leer), el rol de administrador no se puede pedir desde el registro, el panel y su API están bloqueados en el servidor para quien no es admin, y el pago se confirma consultando a Mercado Pago (no se confía en lo que dice el navegador).

## 3. Mercado Pago (Checkout Pro)

Ya está integrado. Solo necesitás las credenciales:

1. Entrá a https://www.mercadopago.com.ar/developers y creá una **aplicación** (tipo "Checkout Pro").
2. En *Credenciales de prueba* copiá el **Access Token** (empieza con `TEST-`) y pegalo en `MP_ACCESS_TOKEN` del `.env`. Reiniciá el servidor.
3. Probá comprando con las *cuentas de prueba* y *tarjetas de prueba* que ofrece Mercado Pago.
4. Para cobrar de verdad: usá el Access Token de **producción** (`APP_USR-...`) y activá las credenciales de producción en tu aplicación.

**Importante – avisos automáticos (webhook):** Mercado Pago solo puede avisarle a tu sitio si este tiene una dirección pública con **https** (por ejemplo `https://tudominio.com`). Cuando pongas esa dirección en `BASE_URL`, el servidor la envía en cada pago y empiezan los avisos. Mientras pruebes en `localhost` igual funciona: cuando el cliente vuelve a la tienda después de pagar, el servidor verifica el pago con Mercado Pago. Si querés validar la autenticidad de los avisos, copiá la "clave secreta" de *Tus integraciones → Webhooks* en `MP_WEBHOOK_SECRET`.

Detalles de la integración: solo se permiten medios de pago inmediatos (tarjetas, dinero en cuenta); se excluyen pagos en efectivo para que una prenda no quede reservada días.

## 4. Base de datos

La base ya está incluida y funcionando: es **SQLite**, un único archivo (`data/saturno.db`) que se crea solo al iniciar el servidor. El diseño está en `database/schema.sql`:

| Tabla | Para qué sirve |
|---|---|
| `users` | Clientes y admin (email, contraseña cifrada, rol) |
| `sessions` | Sesiones iniciadas |
| `products` | Prendas: nombre, descripción, precio, foto, estado (`available`/`sold`) y reserva |
| `cart_items` | Carrito de cada usuario |
| `orders` | Pedidos (`pending`, `paid`, `cancelled`, `conflict`) |
| `order_items` | Prendas de cada pedido, con el precio del momento |

**Ver / editar la base a mano:** instalá gratis *DB Browser for SQLite* y abrí `data/saturno.db`.

**Copias de seguridad:** copiá la carpeta `data/` entera (tiene la base y las fotos subidas). Hacelo con el servidor apagado o usando el archivo `.db` junto con sus `-wal`/`-shm` si existen.

**Cambiar el precio o agregar prendas:** hacelo desde el panel de administración, no hace falta tocar la base.

### Si más adelante querés otra base (MySQL / PostgreSQL)
SQLite alcanza de sobra para una tienda de ropa chica (miles de prendas y pedidos). Si querés migrar:
1. `schema.sql` se traduce casi directo (cambiá `INTEGER PRIMARY KEY AUTOINCREMENT` por `AUTO_INCREMENT` en MySQL o `GENERATED ... AS IDENTITY` en PostgreSQL).
2. Todo el acceso a datos está en `server.js` con consultas SQL simples (`db.prepare(...)`), y las operaciones críticas (pago, reserva) usan la función `tx()` (transacción): ahí es donde habría que adaptar el conector.

## 5. Publicarla en internet

Como tiene servidor y base de datos, **no sirve un hosting estático** (GitHub Pages, Netlify común). Necesitás un hosting que ejecute Node.js 22+ y que tenga **disco persistente** (si no, se borra la base en cada reinicio): por ejemplo Render, Railway, Fly.io o un VPS.

En el hosting configurá estas variables de entorno (en vez del archivo `.env`):
`NODE_ENV=production`, `BASE_URL=https://tudominio.com`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `MP_ACCESS_TOKEN`, `TRUST_PROXY=true` y `DATA_DIR` apuntando al disco persistente. Comando de inicio: `npm start`.

## 6. Estructura

```
server.js            Servidor: API, base de datos, login, stock y Mercado Pago
database/schema.sql  Diseño de la base de datos
public/              Lo que ve el navegador
  index.html/.js     Catálogo
  login.html, registro.html, auth.js
  carrito.html/.js   Carrito y botón de pago
  pago-resultado.*   Resultado del pago
  pago-demo.*        Pago simulado (solo sin Mercado Pago)
  admin.html/.js     Panel del administrador
  script.js          Código compartido (encabezado, sesión)
  style.css          Estilos (tu diseño original + lo nuevo)
data/                Se crea sola: base de datos y fotos subidas
```
