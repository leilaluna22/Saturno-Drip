/* Catálogo: muestra las prendas y permite agregarlas al carrito */
(function () {
    'use strict';
    const list = document.getElementById('listaProductos');

    function card(p) {
        const sold = p.state === 'sold';
        const reserved = p.state === 'reserved';
        const wa = `https://wa.me/${SD.WHATSAPP}?text=${encodeURIComponent('Hola, quiero consultar por ' + p.name)}`;

        let action;
        if (sold) action = '<button class="btn-cart" disabled>Agotado</button>';
        else if (reserved) action = '<button class="btn-cart" disabled>Reservada por otra persona</button>';
        else if (p.inCart) action = '<a class="btn-cart in-cart" href="/carrito.html">✓ En tu carrito · Ver carrito</a>';
        else action = `<button class="btn-cart" data-add="${p.id}">Agregar al carrito</button>`;

        const badge = sold ? '<span class="badge badge-sold">Agotado</span>'
            : reserved ? '<span class="badge badge-reserved">Reservada</span>' : '';

        return `
            <article class="producto ${sold ? 'is-sold' : ''}">
                <div class="imagen">
                    ${p.image ? `<img src="${SD.esc(p.image)}" alt="${SD.esc(p.name)}">` : ''}
                    ${badge}
                </div>
                <div class="producto-info">
                    <h3>${SD.esc(p.name)}</h3>
                    <p>${SD.esc(p.description)}</p>
                    <span class="precio">${SD.money(p.price)}</span>
                    ${action}
                    <a class="whatsapp" href="${wa}" target="_blank" rel="noopener">Consultar por WhatsApp</a>
                </div>
            </article>`;
    }

    async function load() {
        try {
            const { products } = await SD.api('/api/products');
            list.innerHTML = products.length
                ? products.map(card).join('')
                : '<p class="estado-carga">Todavía no hay prendas cargadas.</p>';
        } catch (err) {
            list.innerHTML = `<p class="estado-carga">${SD.esc(err.message)}</p>`;
        }
    }

    list.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-add]');
        if (!btn) return;

        if (!SD.state.user) {
            location.href = '/login.html?next=' + encodeURIComponent('/#productos');
            return;
        }
        btn.disabled = true;
        try {
            const r = await SD.api('/api/cart', { method: 'POST', body: { productId: Number(btn.dataset.add) } });
            SD.setCartCount(r.cartCount);
            SD.toast('Agregada a tu carrito', 'ok');
        } catch (err) {
            SD.toast(err.message, 'error');
        }
        load();
    });

    // Si la persona vuelve a la pestaña, se actualiza el stock
    document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });

    SD.init().then(load);
})();
