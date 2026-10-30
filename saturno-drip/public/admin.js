/* Panel de administración: stock manual de prendas y pedidos */
(function () {
    'use strict';

    const $ = (id) => document.getElementById(id);
    const form = $('productForm');
    let products = [];
    let pendingImage = null;     // archivo elegido pero todavía no subido
    let currentImageUrl = '';    // foto que ya tiene la prenda

    const fmtDate = (ms) => new Date(ms).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' });
    const fmtTime = (ms) => new Date(ms).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });

    /* ---------- Prendas ---------- */

    function badge(p) {
        if (p.state === 'sold') return '<span class="status st-sold">Agotada</span>';
        if (p.state === 'reserved') {
            return `<span class="status st-reserved">Reservada</span>
                    <small class="hint">${SD.esc(p.reservedBy || '')} · hasta ${fmtTime(p.reservedUntil)}</small>`;
        }
        return '<span class="status st-ok">Disponible</span>';
    }

    function actions(p) {
        const toggle = p.state === 'sold'
            ? `<button class="mini" data-act="available" data-id="${p.id}">Volver a disponible</button>`
            : p.state === 'reserved'
                ? `<button class="mini" data-act="available" data-id="${p.id}">Liberar reserva</button>
                   <button class="mini warn" data-act="sold" data-id="${p.id}">Marcar agotada</button>`
                : `<button class="mini warn" data-act="sold" data-id="${p.id}">Marcar agotada</button>`;
        return `${toggle}
                <button class="mini" data-act="edit" data-id="${p.id}">Editar</button>
                <button class="mini danger" data-act="delete" data-id="${p.id}">Eliminar</button>`;
    }

    function renderProducts() {
        const body = $('productsBody');
        if (!products.length) {
            body.innerHTML = '<tr><td colspan="5" class="estado-carga">Todavía no cargaste prendas.</td></tr>';
        } else {
            body.innerHTML = products.map((p) => `
                <tr>
                    <td>${p.image ? `<img class="thumb" src="${SD.esc(p.image)}" alt="">` : '<div class="thumb no-img"></div>'}</td>
                    <td><strong>${SD.esc(p.name)}</strong><br><small class="hint">${SD.esc(p.description)}</small></td>
                    <td>${SD.money(p.price)}</td>
                    <td>${badge(p)}</td>
                    <td><div class="acts">${actions(p)}</div></td>
                </tr>`).join('');
        }
        const count = (s) => products.filter((p) => p.state === s).length;
        $('stats').innerHTML = `
            <div class="stat"><b>${count('available')}</b><span>Disponibles</span></div>
            <div class="stat"><b>${count('reserved')}</b><span>Reservadas</span></div>
            <div class="stat"><b>${count('sold')}</b><span>Agotadas</span></div>`;
    }

    async function loadProducts() {
        try {
            products = (await SD.api('/api/admin/products')).products;
            renderProducts();
        } catch (err) {
            SD.toast(err.message, 'error');
        }
    }

    /* ---------- Formulario ---------- */

    function showPreview(url) {
        $('imgPreview').innerHTML = url ? `<img src="${SD.esc(url)}" alt="Vista previa">` : '<span>Sin foto</span>';
    }

    function openForm(p) {
        form.hidden = false;
        $('formTitle').textContent = p ? 'Editar prenda' : 'Nueva prenda';
        $('pId').value = p ? p.id : '';
        $('pName').value = p ? p.name : '';
        $('pDesc').value = p ? p.description : '';
        $('pPrice').value = p ? p.price : '';
        $('pImage').value = '';
        $('formError').hidden = true;
        pendingImage = null;
        currentImageUrl = p ? p.image : '';
        showPreview(currentImageUrl);
        form.scrollIntoView({ behavior: 'smooth', block: 'start' });
        $('pName').focus();
    }

    function closeForm() { form.hidden = true; }

    $('newBtn').addEventListener('click', () => openForm(null));
    $('cancelBtn').addEventListener('click', closeForm);

    $('pImage').addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        if (file.size > 5 * 1024 * 1024) {
            e.target.value = '';
            return SD.toast('La imagen pesa más de 5 MB.', 'error');
        }
        pendingImage = file;
        showPreview(URL.createObjectURL(file));
    });

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const err = $('formError');
        err.hidden = true;
        const saveBtn = $('saveBtn');
        saveBtn.disabled = true;
        try {
            let image = currentImageUrl;
            if (pendingImage) {
                const up = await SD.api('/api/admin/upload', { method: 'POST', contentType: pendingImage.type, rawBody: pendingImage });
                image = up.url;
            }
            const body = {
                name: $('pName').value, description: $('pDesc').value,
                price: Number($('pPrice').value), image,
            };
            const id = $('pId').value;
            await SD.api(id ? `/api/admin/products/${id}` : '/api/admin/products', { method: id ? 'PUT' : 'POST', body });
            SD.toast(id ? 'Prenda actualizada' : 'Prenda creada', 'ok');
            closeForm();
            loadProducts();
        } catch (ex) {
            err.textContent = ex.message;
            err.hidden = false;
        } finally {
            saveBtn.disabled = false;
        }
    });

    /* ---------- Acciones de la tabla ---------- */

    $('productsBody').addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-act]');
        if (!btn) return;
        const id = Number(btn.dataset.id);
        const p = products.find((x) => x.id === id);
        const act = btn.dataset.act;

        try {
            if (act === 'edit') return openForm(p);
            if (act === 'delete') {
                if (!confirm(`¿Eliminar "${p.name}"? Esta acción no se puede deshacer.`)) return;
                await SD.api(`/api/admin/products/${id}`, { method: 'DELETE', body: {} });
                SD.toast('Prenda eliminada', 'ok');
            } else {
                if (act === 'sold' && !confirm(`¿Marcar "${p.name}" como agotada? Se va a sacar de los carritos.`)) return;
                await SD.api(`/api/admin/products/${id}/status`, { method: 'POST', body: { status: act } });
                SD.toast(act === 'sold' ? 'Marcada como agotada' : 'Prenda disponible', 'ok');
            }
            loadProducts();
        } catch (ex) {
            SD.toast(ex.message, 'error');
        }
    });

    /* ---------- Pedidos ---------- */

    const ORDER_LABEL = {
        paid: ['Pagado', 'st-ok'], pending: ['Esperando pago', 'st-reserved'],
        cancelled: ['Cancelado', 'st-sold'], conflict: ['Devolver dinero', 'st-danger'],
    };

    async function loadOrders() {
        const box = $('ordersList');
        try {
            const { orders } = await SD.api('/api/admin/orders');
            if (!orders.length) { box.innerHTML = '<p class="estado-carga">Todavía no hay pedidos.</p>'; return; }
            box.innerHTML = orders.map((o) => {
                const [label, cls] = ORDER_LABEL[o.status] || [o.status, ''];
                return `
                <article class="order-card">
                    <div class="order-head">
                        <strong>Pedido #${o.id}</strong>
                        <span class="status ${cls}">${label}</span>
                        <span class="order-date">${fmtDate(o.createdAt)}</span>
                    </div>
                    <p><b>${SD.esc(o.customer.name)}</b> · ${SD.esc(o.customer.email)}</p>
                    <ul>${o.items.map((i) => `<li>${SD.esc(i.name)} — ${SD.money(i.price)}</li>`).join('')}</ul>
                    <p class="order-total">Total: <b>${SD.money(o.total)}</b>${o.paymentId ? ` · Pago MP: ${SD.esc(o.paymentId)}` : ''}</p>
                    ${o.note ? `<p class="order-note">${SD.esc(o.note)}</p>` : ''}
                </article>`;
            }).join('');
        } catch (err) {
            box.innerHTML = `<p class="estado-carga">${SD.esc(err.message)}</p>`;
        }
    }

    /* ---------- Pestañas ---------- */

    document.querySelectorAll('.tab').forEach((tab) => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
            const name = tab.dataset.tab;
            $('tab-products').hidden = name !== 'products';
            $('tab-orders').hidden = name !== 'orders';
            if (name === 'orders') loadOrders(); else loadProducts();
        });
    });

    SD.init().then((state) => {
        if (!state.user || state.user.role !== 'admin') { location.href = '/'; return; }
        loadProducts();
    });
})();
