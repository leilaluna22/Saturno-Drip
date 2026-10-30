/* Inicio de sesión y registro (el mismo código sirve para las dos páginas) */
(function () {
    'use strict';
    const form = document.getElementById('authForm');
    const errorBox = document.getElementById('formError');
    const submitBtn = document.getElementById('submitBtn');
    const mode = form.dataset.mode;
    const next = new URLSearchParams(location.search).get('next');

    function showError(msg) {
        errorBox.textContent = msg;
        errorBox.hidden = !msg;
    }

    // Mantener el "next" al cambiar entre login y registro
    if (next) {
        const link = document.getElementById('switchLink');
        link.href += '?next=' + encodeURIComponent(next);
    }

    function goAfterAuth(user) {
        const fallback = user.role === 'admin' ? '/admin.html' : '/';
        location.href = SD.safeNext(next, fallback);
    }

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        showError('');
        const data = Object.fromEntries(new FormData(form));

        if (!data.email || !data.password) return showError('Completá todos los campos.');
        if (mode === 'register') {
            if (!data.name || data.name.trim().length < 2) return showError('Ingresá tu nombre.');
            if (data.password.length < 8) return showError('La contraseña debe tener al menos 8 caracteres.');
            if (data.password !== data.password2) return showError('Las contraseñas no coinciden.');
        }

        submitBtn.disabled = true;
        const original = submitBtn.textContent;
        submitBtn.textContent = 'Un momento…';
        try {
            const body = mode === 'register'
                ? { name: data.name, email: data.email, password: data.password }
                : { email: data.email, password: data.password };
            const r = await SD.api(mode === 'register' ? '/api/register' : '/api/login', { method: 'POST', body });
            goAfterAuth(r.user);
        } catch (err) {
            showError(err.message);
            submitBtn.disabled = false;
            submitBtn.textContent = original;
        }
    });

    // Si ya hay sesión iniciada, no tiene sentido ver esta página
    SD.init().then((state) => { if (state.user) goAfterAuth(state.user); });
})();
