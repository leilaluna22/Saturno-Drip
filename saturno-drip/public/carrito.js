/* Carrito: ver prendas, quitar y pasar a pagar con Mercado Pago */
(function () {
    'use strict';
    const box = document.getElementById('cartContent');

    function render(cart) {
        SD.setCartCount(cart.items.length);

        if (!cart.items.length) {
            box.innerHTML = `
                <div class="cart-empty">
                    <p>Tu carrito está vacío.</p>
                    <a href="/#productos" class="btn">Ver productos</a>
                </div>`;
            return;
        }

        const rows = cart.items.map((it) => {
            const ok = it.state === 'available';
            const msg = it.state === 'sold' ? 'Esta prenda ya se agotó'
                : it.state === 'reserved' ? 'Otra persona la está pagando en este momento' : '';
            return `
                <li class="cart-item ${ok ? '' : 'unavailable'}">
                    ${it.image ? `<img src="${SD.esc(it.image)}" alt="${SD.esc(it.name)}">` : "<div class=\"no-img\"></div>"}
                    <div class="cart-item-info">
                        <h3>${SD.esc(it.name)}</h3>
                        <p>${SD.esc(it.description)}</p>
                        ${ok ? '' : `<p class="cart-warning">⚠ ${msg}. Quitala para poder pagar.</p>`}
                    </div>
                    <div class="cart-item-side">
                        <span class="precio-item">${SD.money(it.price)}</span>
                        <button class="btn-remove" data-remove="${it.id}">Quitar</button>
                    </div>
                </li>`;
        }).join('');

        const availableCount = cart.items.filter((i) => i.state === 'available').length;
        box.innerHTML = `
            <ul class="cart-list">${rows}</ul>
            <aside class="cart-summary">
                <h3>Resumen</h3>
                <div class="summary-row"><span>Prendas</span><span>${availableCount}</span></div>
                <div class="summary-row total"><span>Total</span><span>${SD.money(cart.total)}</span></div>
                <button class="btn-primary" id="payBtn" ${cart.hasUnavailable || !availableCount ? 'disabled' : ''}>
                    Ir a pagar con Mercado Pago
                </button>
                ${cart.hasUnavailable ? '<p class="summary-note">Quitá las prendas no disponibles para continuar.</p>' : ''}
                <p class="summary-note">Al ir a pagar reservamos tus prendas durante unos minutos para que nadie más las compre mientras pagás.</p>
                <a href="/#productos" class="seguir">← Seguir mirando</a>
            </aside>`;
    }

    async function load() {
        try {
            render(await SD.api('/api/cart'));
        } catch (err) {
            box.innerHTML = `<p class="estado-carga">${SD.esc(err.message)}</p>`;
        }
    }

    box.addEventListener('click', async (e) => {
        const remove = e.target.closest('[data-remove]');
        if (remove) {
            remove.disabled = true;
            try {
                render(await SD.api('/api/cart/' + remove.dataset.remove, { method: 'DELETE' }));
            } catch (err) {
                SD.toast(err.message, 'error');
                load();
            }
            return;
        }

        const pay = e.target.closest('#payBtn');
        if (pay) {
            pay.disabled = true;
            pay.textContent = 'Preparando el pago…';
            try {
                const r = await SD.api('/api/checkout', { method: 'POST', body: {} });
                location.href = r.url;
            } catch (err) {
                SD.toast(err.message, 'error');
                load();
            }
        }
    });

    SD.init().then((state) => {
        if (!state.user) {
            location.href = '/login.html?next=' + encodeURIComponent('/carrito.html');
            return;
        }
        load();
    });
})();
