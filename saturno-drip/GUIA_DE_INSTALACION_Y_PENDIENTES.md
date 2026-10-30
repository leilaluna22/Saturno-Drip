# Saturno Drip — instalación, correcciones y tareas pendientes

## Iniciar el proyecto

1. Descomprimí el ZIP: la carpeta raíz debe llamarse `saturno-drip`.
2. Instalá Node.js 22.13 o superior (preferiblemente versión LTS actual).
3. Abrí una terminal dentro de `saturno-drip`.
4. Copiá `.env.example` como `.env` (Windows: `copy .env.example .env`; macOS/Linux: `cp .env.example .env`).
5. Editá `.env` y definí `ADMIN_EMAIL` y una `ADMIN_PASSWORD` privada y robusta. No compartas este archivo.
6. Ejecutá `npm start`.
7. Abrí `http://localhost:3000` y accedé desde `http://localhost:3000/login.html`. Con las credenciales admin, entrarás al panel `/admin.html`.

**Importante:** los enlaces internos del sitio son `/index.html`, `/img/prod1.png`, etc., y NO `/saturno-drip/public/index.html`. La carpeta `public` ya es la raíz pública que sirve Node.js. Abrir HTML mediante doble clic (`file://`) no inicia la API ni la base de datos.

## Base de datos

El servidor crea automáticamente `saturno-drip/data/saturno.db` usando SQLite y ejecuta `database/schema.sql` en cada inicio. No necesitás MySQL ni phpMyAdmin. Podés abrir el archivo con DB Browser for SQLite. Las tablas originales (`users`, `products`, `orders`, `order_items`, `cart_items`, `sessions`) se conservan. Se agregaron las tablas `categories`, `product_variants`, `order_variant_details` y `payments` como base para implementar el modelo del PDF.

**Atención: esquema ampliado no significa funcionalidad terminada.** La API actual todavía gestiona prendas individuales (disponible/vendida), no descuenta unidades por talle/color ni expone un CRUD de categorías y variantes. La compra existente usa Mercado Pago o una simulación local, pero no admite efectivo al retirar. No uses el sistema en producción como si esas funciones estuvieran completas.

## Pendientes para cumplir íntegramente el PDF

1. Migrar `products` para asociar `category_id` y `manager_user_id` con claves foráneas; añadir categoría al panel.
2. Ampliar `/api/products` y `/api/admin/products` para leer y editar talles, colores y unidades desde `product_variants`.
3. Cambiar carrito y `order_items` para seleccionar variante y cantidad; validar y descontar stock dentro de una transacción SQLite, con reserva y recuperación ante cancelación.
4. Añadir pago en efectivo al retirar y flujo administrativo de confirmación de retiro, guardando cada pago en `payments`.
5. Incorporar `/mis-pedidos.html` y endpoints de historial y estados para el cliente.
6. Completar pruebas de Mercado Pago con credenciales de prueba y webhooks verificados antes de habilitar pagos reales.
7. Respaldar periódicamente `data/` y alojarlo en un disco persistente al publicar el sitio.

## Contraseña del administrador

No existe una contraseña real incrustada en `admin.html`: se define en `.env` (`ADMIN_EMAIL`, `ADMIN_PASSWORD`). `.env.example` trae solo valores de muestra. El servidor crea o actualiza el administrador al arrancar. Cambiá la contraseña de ejemplo antes de utilizar el sistema.

## Alcance del documento de propuesta

La propuesta define siete entidades: Usuario, Categoría, Producto, Variante, Pedido, Detalle de pedido y Pago (páginas 20–21), más autenticación, catálogo, compra, seguimiento y panel de administración. Esta entrega repara las rutas y prepara el esquema ampliado; las funciones pendientes se detallan arriba.
