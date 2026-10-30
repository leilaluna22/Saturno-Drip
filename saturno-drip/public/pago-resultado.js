/* Resultado del pago: le preguntamos al servidor (que consulta a Mercado Pago), no confiamos en la URL */
(function () {
    'use strict';
    const box = document.getElementById('result');
    const params = new URLSearchParams(location.search);
    const orderId = params.get('external_reference') || params.get('order');
    const paymentId = params.get('payment_id') || params.get('collection_id');
    let retries = 0;

    function show(icon, title, text, buttons) {
        box.innerHTML = `
            <div class="result-icon">${icon}</div>
            <h2>${title}</h2>
            <p>${text}</p>
            <div class="result-actions">${buttons}</div>`;
    }

    async function check() {
        if (!orderId || !/^\d+$/.test(orderId)) {
            return show('❔', 'No encontramos el pedido', 'Volvé a la tienda para seguir comprando.',
                '<a href="/" class="btn">Ir al inicio</a>');
        }
        try {
            const qs = paymentId && /^\d+$/.test(paymentId) ? '?payment_id=' + paymentId : '';
            const r = await SD.api(`/api/orders/${orderId}/verify${qs}`);

            if (r.status === 'paid') {
                const items = r.items.map((i) => `<li>${SD.esc(i.name)} — ${SD.money(i.price)}</li>`).join('');
                show('🎉', '¡Pago confirmado!',
                    `Gracias por tu compra. Pedido #${r.orderId} por ${SD.money(r.total)}.<ul class="result-items">${items}</ul>
                     Nos vamos a comunicar con vos para coordinar la entrega.`,
                    '<a href="/" class="btn">Seguir mirando</a>');
                SD.setCartCount(0);
            } else if (r.status === 'conflict') {
                show('⚠️', 'Recibimos tu pago, pero hubo un problema',
                    'Una de las prendas ya no estaba disponible. Te vamos a devolver el dinero. Escribinos por WhatsApp si necesitás ayuda.',
                    `<a href="https://wa.me/${SD.WHATSAPP}" target="_blank" rel="noopener" class="btn">Escribir por WhatsApp</a>`);
            } else if (r.status === 'pending' && retries < 4 && params.get('status') !== 'failure') {
                retries++;
                show('⏳', 'Esperando la confirmación…', 'Mercado Pago todavía está procesando tu pago. Esto puede tardar unos segundos.', '');
                setTimeout(check, 3000);
            } else if (r.status === 'pending') {
                show('⏳', 'El pago no se completó',
                    'Tus prendas siguen reservadas por unos minutos. Podés volver al carrito e intentar de nuevo.',
                    '<a href="/carrito.html" class="btn">Volver al carrito</a>');
            } else {
                show('😕', 'El pago no se realizó',
                    'No se cobró nada. Podés volver al carrito e intentarlo otra vez, si las prendas siguen disponibles.',
                    '<a href="/carrito.html" class="btn">Volver al carrito</a>');
            }
        } catch (err) {
            show('😕', 'No pudimos verificar el pago', SD.esc(err.message),
                '<a href="/carrito.html" class="btn">Ir al carrito</a>');
        }
    }

    SD.init().then((state) => {
        if (!state.user) {
            location.href = '/login.html?next=' + encodeURIComponent('/pago-resultado.html' + location.search);
            return;
        }
        check();
    });
})();
