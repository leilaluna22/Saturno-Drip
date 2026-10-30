/* Saturno Drip - Código compartido por todas las páginas
   (encabezado, sesión del usuario, carrito, avisos y llamadas al servidor) */
(function () {
    'use strict';

    const WHATSAPP = '5491150288068';
    const state = { user: null, cartCount: 0 };

    /* ---------- Utilidades ---------- */

    // Llama a la API del servidor. Lanza un Error con mensaje en español si algo falla.
    async function api(url, opts = {}) {
        const method = opts.method || 'GET';
        const init = { method, headers: {}, credentials: 'same-origin' };
        if (method !== 'GET') {
            init.headers['Content-Type'] = opts.contentType || 'application/json';
            if (opts.rawBody !== undefined) init.body = opts.rawBody;
            else if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
        }
        let res;
        try {
            res = await fetch(url, init);
        } catch {
            throw new Error('No pudimos conectar con el servidor. Revisá tu conexión.');
        }
        let data = null;
        try { data = await res.json(); } catch { /* sin cuerpo */ }
        if (!res.ok) {
            const err = new Error((data && data.error) || 'Ocurrió un error. Probá de nuevo.');
            err.status = res.status;
            err.data = data;
            throw err;
        }
        return data;
    }

    // Evita que un texto se interprete como HTML (protección XSS)
    function esc(value) {
        return String(value ?? '').replace(/[&<>"']/g, (c) => (
            { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
        ));
    }

    const money = (n) => '$' + Number(n).toLocaleString('es-AR');

    function toast(message, type = 'info') {
        let box = document.getElementById('toasts');
        if (!box) {
            box = document.createElement('div');
            box.id = 'toasts';
            document.body.appendChild(box);
        }
        const el = document.createElement('div');
        el.className = 'toast toast-' + type;
        el.textContent = message;
        box.appendChild(el);
        setTimeout(() => el.classList.add('hide'), 3800);
        setTimeout(() => el.remove(), 4300);
    }

    // Solo permite volver a rutas internas del sitio (evita redirecciones a otras webs)
    function safeNext(value, fallback) {
        return typeof value === 'string' && /^\/(?!\/)[\w\-./?=&%#]*$/.test(value) ? value : fallback;
    }

    /* ---------- Encabezado ---------- */

    const cartIcon = '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="#222" stroke-width="1.8" ' +
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="20" r="1.4"/>' +
        '<circle cx="18" cy="20" r="1.4"/><path d="M2 3h3l2.7 12.4a1.5 1.5 0 0 0 1.5 1.2h8.6a1.5 1.5 0 0 0 1.5-1.1L21 8H6"/></svg>';

    function renderHeader() {
        const header = document.getElementById('site-header');
        if (!header) return;

        let menu;
        if (state.user) {
            menu = `
                <h3>Hola, ${esc(state.user.name.split(' ')[0])}</h3>
                <p class="user-email">${esc(state.user.email)}</p>
                ${state.user.role === 'admin' ? '<a href="/admin.html" class="drop-l">Panel de administración</a>' : ''}
                <a href="/carrito.html" class="${state.user.role === 'admin' ? 'drop-r' : 'drop-l'}">Mi carrito</a>
                <a href="#" class="drop-r" id="logoutLink">Cerrar sesión</a>`;
        } else {
            menu = `
                <h3>Bienvenido</h3>
                <a href="/login.html" class="drop-l">Iniciar sesión</a>
                <a href="/registro.html" class="drop-r">Registrarse</a>`;
        }

        header.innerHTML = `
            <div><a href="/index.html"><img src="/img/SDlogo.png" class="logoa" alt="Saturno Drip"></a></div>
            <div class="logo">
                <h1>Saturno Drip</h1>
                <p>Catálogo, productos de calidad.</p>
            </div>
            <nav>
                <a href="/index.html">Inicio</a>
                <a href="#productos">Productos</a>
                <a href="#contacto">Contacto</a>
            </nav>
            <div class="header-actions">
                <a href="/carrito.html" class="cart-link" aria-label="Carrito">
                    ${cartIcon}<span class="cart-count" id="cartCount" hidden>0</span>
                </a>
                <div class="user-menu">
                    <button class="user-button" id="userButton" type="button" aria-label="Mi cuenta">
                        <span class="user-icon"><img src="/img/login.png" class="login" alt=""></span>
                    </button>
                    <div class="user-drop" id="usera">${menu}</div>
                </div>
            </div>`;

        const userButton = document.getElementById('userButton');
        const usera = document.getElementById('usera');
        userButton.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            usera.classList.toggle('active');
        });
        document.addEventListener('click', () => usera.classList.remove('active'));
        usera.addEventListener('click', (e) => e.stopPropagation());

        const logout = document.getElementById('logoutLink');
        if (logout) {
            logout.addEventListener('click', async (e) => {
                e.preventDefault();
                try { await api('/api/logout', { method: 'POST', body: {} }); } catch { /* ignorar */ }
                location.href = '/';
            });
        }
        setCartCount(state.cartCount);
    }

    function setCartCount(n) {
        state.cartCount = n;
        const badge = document.getElementById('cartCount');
        if (!badge) return;
        badge.textContent = n;
        badge.hidden = !n;
    }

    // Carga la sesión y dibuja el encabezado. Las páginas esperan este resultado.
    async function init() {
        try {
            const me = await api('/api/me');
            state.user = me.user;
            state.cartCount = me.cartCount;
        } catch (err) {
            toast(err.message, 'error');
        }
        renderHeader();
        return state;
    }

    window.SD = { api, esc, money, toast, safeNext, init, setCartCount, state, WHATSAPP };
})();
