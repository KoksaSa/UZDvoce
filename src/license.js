/* ============================================================================
 *  Модуль лицензирования «ГолосУЗИ (UZD Voce) · Приказ 1130н»
 *  ---------------------------------------------------------------------------
 *  • Триал 3 дня с момента первого запуска (фиксируется в 4 хранилищах).
 *  • Платная лицензия — подписанный ECDSA P-256 токен, выданный владельцем.
 *  • Привязка к устройству: токен содержит ID устройства (до 2 устройств).
 *  • Проверка полностью офлайн, интернет нужен только один раз — для
 *    получения ключа по почте.
 *
 *  Приватный ключ подписи НИКОГДА не попадает в этот файл — только публичный.
 * ========================================================================== */
(function (window, document) {
    'use strict';

    /* Публичный ключ владельца. Подставляется сборщиком (tools/build.mjs). */
    var PUBLIC_JWK = __UZI_PUBLIC_JWK__;

    var TOKEN_PREFIX = 'UZI1-';
    var TRIAL_DAYS = 3;
    var TRIAL_MS = TRIAL_DAYS * 86400000;
    var ROLLBACK_TOLERANCE = 6 * 3600000;      // 6 часов — допуск на смену часовых поясов
    var ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

    var K = {
        license: 'uzi-lic-1130n:license',
        device: 'uzi-lic-1130n:device',
        first: 'uzi-lic-1130n:first',
        maxseen: 'uzi-lic-1130n:maxseen'
    };
    var COOKIE_PREFIX = 'uzi_lic_';
    var IDB_NAME = 'uzi-license-1130n';
    var CACHE_NAME = 'uzi-lic-1130n-cache';
    var CACHE_URL = location.origin + '/__uzi_lic_meta__';

    /* Кнопки, которые блокируются без действующей лицензии. */
    var GATED_IDS = ['pdfBtn', 'pdfBtn2', 'docBtn', 'docBtn2', 'copyBtn',
        'shareBtn', 'shareBtn2', 'printBtn', 'snapshotBtn'];

    var status = {
        state: 'loading',      // loading | active | trial | expired | none
        canUse: false,
        deviceId: '',
        owner: '',
        exp: 0,
        daysLeft: 0,
        tampered: false
    };
    var listeners = [];
    var idbPromise = null;

    /* ======================================================================
     *  Хранилища: IndexedDB + localStorage + cookie + Cache API
     * ==================================================================== */

    function idbOpen() {
        if (idbPromise) return idbPromise;
        idbPromise = new Promise(function (resolve) {
            if (!window.indexedDB) return resolve(null);
            var req;
            try { req = indexedDB.open(IDB_NAME, 1); } catch (e) { return resolve(null); }
            req.onupgradeneeded = function () {
                var db = req.result;
                if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
            };
            req.onsuccess = function () { resolve(req.result); };
            req.onerror = function () { resolve(null); };
            req.onblocked = function () { resolve(null); };
        });
        return idbPromise;
    }

    function idbGet(key) {
        return idbOpen().then(function (db) {
            if (!db) return null;
            return new Promise(function (resolve) {
                try {
                    var r = db.transaction('meta', 'readonly').objectStore('meta').get(key);
                    r.onsuccess = function () { resolve(r.result == null ? null : r.result); };
                    r.onerror = function () { resolve(null); };
                } catch (e) { resolve(null); }
            });
        });
    }

    function idbSet(key, value) {
        return idbOpen().then(function (db) {
            if (!db) return;
            return new Promise(function (resolve) {
                try {
                    var tx = db.transaction('meta', 'readwrite');
                    tx.objectStore('meta').put(value, key);
                    tx.oncomplete = function () { resolve(); };
                    tx.onerror = function () { resolve(); };
                } catch (e) { resolve(); }
            });
        });
    }

    function lsGet(key) {
        try { return localStorage.getItem(key); } catch (e) { return null; }
    }
    function lsSet(key, value) {
        try { localStorage.setItem(key, value); } catch (e) { /* private mode */ }
    }

    function cookieGet(key) {
        try {
            var m = document.cookie.match(new RegExp('(?:^|;\\s*)' + COOKIE_PREFIX + key + '=([^;]*)'));
            return m ? decodeURIComponent(m[1]) : null;
        } catch (e) { return null; }
    }
    function cookieSet(key, value) {
        try {
            var d = new Date();
            d.setTime(d.getTime() + 3650 * 86400000);
            document.cookie = COOKIE_PREFIX + key + '=' + encodeURIComponent(value) +
                ';expires=' + d.toUTCString() + ';path=/;SameSite=Lax';
        } catch (e) { /* ignore */ }
    }

    function cacheGet(key) {
        if (!('caches' in window)) return Promise.resolve(null);
        return caches.open(CACHE_NAME)
            .then(function (c) { return c.match(CACHE_URL + '#' + key); })
            .then(function (r) { return r ? r.text() : null; })
            .catch(function () { return null; });
    }
    function cacheSet(key, value) {
        if (!('caches' in window)) return Promise.resolve();
        return caches.open(CACHE_NAME).then(function (c) {
            return c.put(CACHE_URL + '#' + key,
                new Response(String(value), { headers: { 'content-type': 'text/plain' } }));
        }).catch(function () { });
    }

    /* Записать значение во все доступные хранилища. */
    function persist(key, value) {
        var v = String(value);
        return Promise.all([
            idbSet(key, v),
            Promise.resolve(lsSet(key, v)),
            Promise.resolve(cookieSet(key, v)),
            cacheSet(key, v)
        ]);
    }

    /* Прочитать значение из всех хранилищ (первое непустое). */
    function readAny(key) {
        return Promise.all([idbGet(key), Promise.resolve(lsGet(key)),
        Promise.resolve(cookieGet(key)), cacheGet(key)]).then(function (vals) {
            for (var i = 0; i < vals.length; i++) if (vals[i]) return vals[i];
            return null;
        });
    }

    /* Минимум среди всех числовых значений (самая ранняя метка). */
    function readMin(key) {
        return Promise.all([idbGet(key), Promise.resolve(lsGet(key)),
        Promise.resolve(cookieGet(key)), cacheGet(key)]).then(function (vals) {
            var min = null;
            for (var i = 0; i < vals.length; i++) {
                var n = parseInt(vals[i], 10);
                if (Number.isFinite(n) && n > 0 && (min === null || n < min)) min = n;
            }
            return min;
        });
    }

    /* Максимум среди всех числовых значений (защита от отката часов). */
    function readMax(key) {
        return Promise.all([idbGet(key), Promise.resolve(lsGet(key)),
        Promise.resolve(cookieGet(key)), cacheGet(key)]).then(function (vals) {
            var max = null;
            for (var i = 0; i < vals.length; i++) {
                var n = parseInt(vals[i], 10);
                if (Number.isFinite(n) && n > 0 && (max === null || n > max)) max = n;
            }
            return max;
        });
    }

    /* ======================================================================
     *  ID устройства
     * ==================================================================== */

    function formatId(bytes) {
        var bits = '', out = '';
        for (var i = 0; i < bytes.length; i++) {
            var b = bytes[i].toString(2);
            while (b.length < 8) b = '0' + b;
            bits += b;
        }
        for (var j = 0; j < 16; j++) out += ALPHABET[parseInt(bits.substr(j * 5, 5), 2)];
        return out.slice(0, 4) + '-' + out.slice(4, 8) + '-' + out.slice(8, 12) + '-' + out.slice(12, 16);
    }

    function newDeviceId() {
        var bytes = new Uint8Array(10);
        (window.crypto || window.msCrypto).getRandomValues(bytes);
        return formatId(bytes);
    }

    function normalizeId(id) {
        return String(id || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
    }

    /* ======================================================================
     *  Разбор и проверка токена
     * ==================================================================== */

    function b64urlBytes(str) {
        var s = String(str).replace(/-/g, '+').replace(/_/g, '/');
        while (s.length % 4) s += '=';
        var bin = atob(s);
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return bytes;
    }

    function utf8(bytes) {
        if (window.TextDecoder) return new TextDecoder('utf-8').decode(bytes);
        return decodeURIComponent(escape(String.fromCharCode.apply(null, bytes)));
    }

    function parseToken(token) {
        var t = String(token || '').trim().replace(/\s+/g, '');
        if (t.indexOf(TOKEN_PREFIX) !== 0) throw new Error('Ключ должен начинаться с ' + TOKEN_PREFIX);
        var body = t.slice(TOKEN_PREFIX.length);
        var dot = body.indexOf('.');
        if (dot < 0) throw new Error('Повреждённый ключ: нет подписи');
        var payloadB64 = body.slice(0, dot);
        var sigBytes = b64urlBytes(body.slice(dot + 1));
        var payload = JSON.parse(utf8(b64urlBytes(payloadB64)));
        return { data: new TextEncoder().encode(payloadB64), sig: sigBytes, payload: payload };
    }

    function subtleAvailable() {
        return !!(window.crypto && window.crypto.subtle && window.TextEncoder);
    }

    function verifySignature(parsed) {
        if (!subtleAvailable()) return Promise.resolve(false);
        return crypto.subtle
            .importKey('jwk', PUBLIC_JWK, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
            .then(function (key) {
                return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, parsed.sig, parsed.data);
            })
            .catch(function () { return false; });
    }

    /* ======================================================================
     *  Вычисление статуса
     * ==================================================================== */

    function setStatus(next) {
        status = next;
        listeners.forEach(function (cb) { try { cb(status); } catch (e) { } });
        renderChip();
        renderBanner();
    }

    function refresh() {
        var now = Date.now();

        return Promise.all([
            readAny(K.license), readAny(K.device), readMin(K.first), readMax(K.maxseen)
        ]).then(function (r) {
            var licenseRaw = r[0], deviceRaw = r[1], first = r[2], maxSeen = r[3] || 0;

            /* защита от перевода часов назад */
            var tampered = now < maxSeen - ROLLBACK_TOLERANCE;
            if (now > maxSeen) persist(K.maxseen, now);

            /* первый запуск — фиксируем самое раннее известное время */
            if (!first) { first = now; persist(K.first, first); }

            /* ID устройства */
            var deviceId = deviceRaw || newDeviceId();
            if (!deviceRaw) persist(K.device, deviceId);

            var base = {
                deviceId: deviceId, tampered: tampered,
                owner: '', exp: 0, daysLeft: 0, canUse: false, state: 'expired'
            };

            var trialEnd = first + TRIAL_MS;
            var trialLeft = Math.ceil((trialEnd - now) / 86400000);

            function applyTrial() {
                if (!tampered && now <= trialEnd) {
                    base.state = 'trial'; base.canUse = true; base.exp = trialEnd;
                    base.daysLeft = Math.max(0, trialLeft);
                } else {
                    base.state = 'expired'; base.canUse = false; base.exp = trialEnd;
                    base.daysLeft = 0;
                }
                setStatus(base);
                return base;
            }

            if (!licenseRaw) return applyTrial();

            var parsed;
            try { parsed = parseToken(licenseRaw); } catch (e) { return applyTrial(); }

            return verifySignature(parsed).then(function (ok) {
                if (!ok) return applyTrial();

                var p = parsed.payload || {};
                var devices = (p.d || []).map(normalizeId);
                var mine = normalizeId(deviceId);
                var deviceOk = devices.indexOf(mine) >= 0;
                if (!deviceOk) return applyTrial();       // ключ от другого устройства → считаем как триал

                base.owner = p.n || '';
                base.exp = p.exp || 0;
                var left = Math.ceil((base.exp - now) / 86400000);
                base.daysLeft = Math.max(0, left);

                if (tampered) {
                    base.state = 'expired'; base.canUse = false;
                } else if (now <= base.exp) {
                    base.state = 'active'; base.canUse = true;
                } else {
                    base.state = 'expired'; base.canUse = false;
                }
                setStatus(base);
                return base;
            });
        }).catch(function () {
            setStatus({ state: 'expired', canUse: false, deviceId: status.deviceId, owner: '', exp: 0, daysLeft: 0, tampered: false });
        });
    }

    /* ======================================================================
     *  Активация
     * ==================================================================== */

    function activate(token) {
        if (!subtleAvailable()) {
            return Promise.resolve({ ok: false, error: 'Браузер не поддерживает проверку подписи (нужен https).' });
        }
        var parsed;
        try { parsed = parseToken(token); }
        catch (e) { return Promise.resolve({ ok: false, error: e.message }); }

        return verifySignature(parsed).then(function (ok) {
            if (!ok) return { ok: false, error: 'Ключ недействителен или повреждён.' };

            var p = parsed.payload || {};
            var devices = (p.d || []).map(normalizeId);
            var mine = normalizeId(status.deviceId);
            if (devices.indexOf(mine) < 0) {
                return { ok: false, error: 'Этот ключ выдан для другого устройства. Ваш ID: ' + status.deviceId };
            }
            if (Date.now() > (p.exp || 0)) {
                return { ok: false, error: 'Срок действия ключа истёк ' + fmtDate(p.exp) + '.' };
            }
            return persist(K.license, String(token).trim().replace(/\s+/g, ''))
                .then(function () { return refresh(); })
                .then(function () {
                    if (status.canUse) return { ok: true, status: status };
                    return { ok: false, error: 'Ключ сохранён, но активация не подтвердилась.' };
                });
        });
    }

    function deactivate() {
        return persist(K.license, '').then(function () { return refresh(); });
    }

    /* ======================================================================
     *  Интерфейс
     * ==================================================================== */

    function fmtDate(ms) {
        try { return new Date(ms).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' }); }
        catch (e) { return '—'; }
    }

    function el(tag, cls, html) {
        var e = document.createElement(tag);
        if (cls) e.className = cls;
        if (html != null) e.innerHTML = html;
        return e;
    }

    function licToast(type, title, text) {
        var wrap = document.getElementById('toastWrap');
        if (!wrap) return;
        var t = el('div', 'toast ' + (type || 'info'));
        t.innerHTML = '<div class="toast-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
            'stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/>' +
            '<path d="M12 8v4M12 16h.01"/></svg></div><div class="toast-content">' +
            '<div class="toast-title"></div>' + (text ? '<div class="toast-text"></div>' : '') + '</div>';
        t.querySelector('.toast-title').textContent = title || '';
        if (text) t.querySelector('.toast-text').textContent = text;
        wrap.appendChild(t);
        setTimeout(function () {
            t.style.transition = 'all .3s ease'; t.style.opacity = '0'; t.style.transform = 'translateX(30px)';
            setTimeout(function () { t.remove(); }, 300);
        }, 4500);
    }

    /* — Чип в шапке — */
    var chip = null;
    function ensureChip() {
        if (chip) return chip;
        chip = el('button', 'lic-chip');
        chip.type = 'button';
        chip.addEventListener('click', function () { openActivation(); });
        var topbar = document.querySelector('.topbar');
        var actions = document.querySelector('.topbar-actions');
        if (topbar && actions) topbar.insertBefore(chip, actions);
        else if (topbar) topbar.appendChild(chip);
        return chip;
    }

    function renderChip() {
        var c = ensureChip();
        if (!c) return;
        c.classList.remove('is-active', 'is-trial', 'is-expired');
        var label, title;
        if (status.state === 'active') {
            c.classList.add('is-active');
            label = 'Лицензия до ' + fmtDate(status.exp);
            title = 'Активна' + (status.owner ? ' · ' + status.owner : '');
        } else if (status.state === 'trial') {
            c.classList.add('is-trial');
            label = 'Пробный: ' + status.daysLeft + ' ' + plural(status.daysLeft, 'день', 'дня', 'дней');
            title = 'Пробный период до ' + fmtDate(status.exp);
        } else if (status.state === 'loading') {
            label = 'Проверка…'; title = '';
        } else {
            c.classList.add('is-expired');
            label = 'Не активировано';
            title = status.tampered ? 'Обнаружено изменение системных часов' : 'Требуется активация';
        }
        c.textContent = label;
        c.title = title;
    }

    /* — Баннер снизу при истечении — */
    var banner = null;
    function renderBanner() {
        var need = (status.state === 'expired' || status.state === 'none');
        if (!need) { if (banner) banner.classList.remove('visible'); return; }
        if (!banner) {
            banner = el('div', 'lic-banner');
            banner.innerHTML = '<div class="lic-banner-text"></div>' +
                '<button type="button" class="btn btn-primary lic-banner-btn">Активировать</button>';
            banner.querySelector('.lic-banner-btn').addEventListener('click', function () { openActivation(); });
            document.body.appendChild(banner);
        }
        banner.querySelector('.lic-banner-text').textContent = status.tampered
            ? 'Обнаружено изменение системных часов. Экспорт документов заблокирован.'
            : 'Пробный период завершён. Экспорт и печать документов заблокированы.';
        banner.classList.add('visible');
    }

    /* — Модальное окно активации — */
    var modal = null;
    function ensureModal() {
        if (modal) return modal;
        modal = document.getElementById('licModal');
        if (!modal) return null;

        modal.querySelectorAll('[data-close]').forEach(function (b) {
            b.addEventListener('click', closeActivation);
        });
        modal.addEventListener('click', function (e) { if (e.target === modal) closeActivation(); });

        var copyBtn = modal.querySelector('#licCopy');
        if (copyBtn) copyBtn.addEventListener('click', function () {
            var id = status.deviceId || '';
            var done = function () { licToast('success', 'ID скопирован', id); };
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(id).then(done).catch(function () { selectText(modal.querySelector('#licDeviceId')); });
            } else selectText(modal.querySelector('#licDeviceId'));
        });

        var actBtn = modal.querySelector('#licActivate');
        if (actBtn) actBtn.addEventListener('click', doActivateFromModal);

        var deact = modal.querySelector('#licDeactivate');
        if (deact) deact.addEventListener('click', function () {
            if (!confirm('Снять активацию на этом устройстве?')) return;
            deactivate().then(function () { licToast('info', 'Лицензия удалена с этого устройства'); });
        });

        return modal;
    }

    function selectText(node) {
        if (!node) return;
        try {
            var range = document.createRange();
            range.selectNodeContents(node);
            var sel = window.getSelection();
            sel.removeAllRanges(); sel.addRange(range);
        } catch (e) { }
    }

    function doActivateFromModal() {
        var input = modal.querySelector('#licToken');
        var msg = modal.querySelector('#licMessage');
        var btn = modal.querySelector('#licActivate');
        var token = (input.value || '').trim();
        if (!token) { msg.textContent = 'Вставьте ключ активации.'; msg.className = 'lic-message error'; return; }
        btn.disabled = true; btn.classList.add('busy');
        msg.textContent = 'Проверяем ключ…'; msg.className = 'lic-message';
        activate(token).then(function (res) {
            btn.disabled = false; btn.classList.remove('busy');
            if (res.ok) {
                msg.textContent = 'Активация успешна! Действует до ' + fmtDate(res.status.exp) + '.';
                msg.className = 'lic-message success';
                input.value = '';
                licToast('success', 'Программа активирована', 'Лицензия до ' + fmtDate(res.status.exp));
                renderModal();
                setTimeout(closeActivation, 1600);
            } else {
                msg.textContent = res.error || 'Не удалось активировать.';
                msg.className = 'lic-message error';
            }
        });
    }

    function renderModal() {
        if (!modal) return;
        var idNode = modal.querySelector('#licDeviceId');
        if (idNode) idNode.textContent = status.deviceId || '—';

        var badge = modal.querySelector('#licStatusBadge');
        if (badge) {
            badge.className = 'lic-status-badge ' + status.state;
            if (status.state === 'active') badge.textContent = 'Активна · до ' + fmtDate(status.exp) + (status.owner ? ' · ' + status.owner : '');
            else if (status.state === 'trial') badge.textContent = 'Пробный период · осталось ' + status.daysLeft + ' ' + plural(status.daysLeft, 'день', 'дня', 'дней');
            else if (status.tampered) badge.textContent = 'Экспорт заблокирован: изменены системные часы';
            else badge.textContent = 'Не активирована · пробный период завершён';
        }

        var deact = modal.querySelector('#licDeactivate');
        if (deact) deact.style.display = (status.state === 'active') ? 'inline-flex' : 'none';
    }

    function openActivation(reason) {
        var m = ensureModal();
        if (!m) { licToast('error', 'Окно активации недоступно'); return; }
        renderModal();
        m.classList.add('active');
        document.body.style.overflow = 'hidden';
        var msg = m.querySelector('#licMessage');
        if (reason === 'blocked' && msg) {
            msg.textContent = status.tampered
                ? 'Экспорт заблокирован: обнаружено изменение системных часов.'
                : 'Экспорт заблокирован: пробный период завершён. Введите ключ активации.';
            msg.className = 'lic-message error';
        }
        setTimeout(function () {
            var inp = m.querySelector('#licToken');
            if (inp && !inp.value) { try { inp.focus(); } catch (e) { } }
        }, 200);
    }

    function closeActivation() {
        if (!modal) return;
        modal.classList.remove('active');
        document.body.style.overflow = '';
    }

    function plural(n, one, few, many) {
        var m10 = n % 10, m100 = n % 100;
        if (m10 === 1 && m100 !== 11) return one;
        if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
        return many;
    }

    /* ======================================================================
     *  Блокировка экспорта без лицензии
     * ==================================================================== */

    document.addEventListener('click', function (e) {
        var node = e.target;
        while (node && node !== document) {
            if (node.id && GATED_IDS.indexOf(node.id) >= 0) {
                if (!status.canUse) {
                    e.preventDefault(); e.stopPropagation();
                    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
                    openActivation('blocked');
                }
                return;
            }
            node = node.parentNode;
        }
    }, true);

    document.addEventListener('keydown', function (e) {
        if (!(e.ctrlKey || e.metaKey)) return;
        var k = (e.key || '').toLowerCase();
        if (k === 'p' || k === 's') {
            if (!status.canUse) {
                e.preventDefault(); e.stopPropagation();
                if (e.stopImmediatePropagation) e.stopImmediatePropagation();
                openActivation('blocked');
            }
        }
    }, true);

    /* Прямой вызов window.print() из консоли тоже блокируем. */
    var nativePrint = window.print;
    window.print = function () {
        if (!status.canUse) { openActivation('blocked'); return; }
        return nativePrint.apply(window, arguments);
    };

    /* ======================================================================
     *  Публичный API и запуск
     * ==================================================================== */

    window.__LIC = {
        get status() { return status; },
        refresh: refresh,
        activate: activate,
        deactivate: deactivate,
        open: openActivation,
        canUse: function () { return status.canUse; },
        onChange: function (cb) { if (typeof cb === 'function') listeners.push(cb); }
    };

    function boot() {
        refresh();
        document.addEventListener('visibilitychange', function () {
            if (document.visibilityState === 'visible') refresh();
        });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();

})(window, document);
