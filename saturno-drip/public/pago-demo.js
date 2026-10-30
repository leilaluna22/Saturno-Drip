/* Simulador de pago (solo existe cuando Mercado Pago no está configurado y no es producción) */
(function () {
    'use strict';
    const orderId = new URLSearchParams(location.search).get('order');

    async function pay(result) {
        document.getElementById('approve').disabled = true;
        document.getElementById('reject').disabled = true;
        try {
            const r = await SD.api('/api/demo/pay', { method: 'POST', body: { orderId: Number(orderId), result } });
            location.href = `/pago-resultado.html?order=${orderId}&status=${r.status === 'approved' ? 'approved' : 'failure'}`;
        } catch (err) {
            SD.toast(err.message, 'error');
        }
    }

    document.getElementById('approve').addEventListener('click', () => pay('approved'));
    document.getElementById('reject').addEventListener('click', () => pay('rejected'));

    SD.init().then((state) => { if (!state.user || !orderId) location.href = '/'; });
})();
