/* Автотесты собранного docs/index.html.
 *
 *   npm run build && npm test
 *
 * Проверяем не только «файл собрался», но и что код реально работает:
 *  - оба скрипта синтаксически корректны, маркеры заменены, обфускация применена;
 *  - модуль лицензии и приложение ЗАПУСКАЮТСЯ в изолированном DOM-окружении;
 *  - триал 3 дня, активация ключом, отказ чужому устройству и подделке;
 *  - блокировка экспорта без лицензии (перехват клика в capture-фазе);
 *  - защита от перевода системных часов назад. */
import { readFileSync, existsSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';

const html = readFileSync('docs/index.html', 'utf8');
let fail = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✔ ' : '  ✖ ') + msg); if (!cond) fail++; };
const section = (t) => console.log('\n  ── ' + t + ' ──');

/* ============================ 1. Целостность ============================ */
section('Целостность сборки');
ok(!html.includes('__UZI_APP_JS__') && !html.includes('__UZI_LIC_JS__'), 'маркеры сборки заменены');
ok(!html.includes('__UZI_PUBLIC_JWK__'), 'публичный ключ подставлен');

const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
ok(scripts.length === 2, 'найдено 2 встроенных скрипта: ' + scripts.length);
scripts.forEach((code, i) => {
    try { new Function(code); ok(true, 'скрипт #' + (i + 1) + ' корректен (' + (code.length / 1024).toFixed(1) + ' КБ)'); }
    catch (e) { ok(false, 'скрипт #' + (i + 1) + ': ' + e.message); }
});

section('Обфускация');
ok(!scripts[0].includes('UZI1-'), 'префикс ключа скрыт');
ok(!scripts[0].includes('uzi-lic-1130n'), 'ключи хранилища скрыты');
ok(!scripts[0].includes('недействителен'), 'тексты сообщений скрыты');

/* ====================== 2. Изолированное DOM-окружение ================== */
function makeEl(tag) {
    const classes = new Set();
    const el = {
        tagName: String(tag || 'div').toUpperCase(),
        style: {}, dataset: {}, value: '', textContent: '', innerHTML: '',
        title: '', type: '', disabled: false, id: '', _q: new Map(),
        classList: {
            add: (...c) => c.forEach((x) => classes.add(x)),
            remove: (...c) => c.forEach((x) => classes.delete(x)),
            contains: (c) => classes.has(c),
            toggle: (c, f) => { const on = f === undefined ? !classes.has(c) : f; on ? classes.add(c) : classes.delete(c); return on; },
        },
        _classes: classes,
        addEventListener() { }, removeEventListener() { },
        appendChild(c) { return c; }, insertBefore(c) { return c; },
        replaceChild() { }, remove() { }, setAttribute() { }, getAttribute() { return null; },
        removeAttribute() { }, focus() { }, scrollIntoView() { }, click() { },
        querySelector(sel) { if (!el._q.has(sel)) el._q.set(sel, makeEl()); return el._q.get(sel); },
        querySelectorAll() { return []; },
        closest() { return null; }, cloneNode() { return makeEl(tag); },
        contains() { return false; },
        get firstChild() { return null; },
    };
    el.parentNode = { replaceChild() { }, appendChild() { } };
    return el;
}

const lsData = {};
const idCache = new Map();
const docListeners = { click: [], keydown: [] };
const RealDate = Date;
let clockOffset = 0;
class SandboxDate extends RealDate {
    constructor(...args) { if (args.length === 0) super(RealDate.now() + clockOffset); else super(...args); }
    static now() { return RealDate.now() + clockOffset; }
}

const sandbox = {
    console, crypto: webcrypto, atob, btoa, TextEncoder, TextDecoder, Response, Blob, File,
    setTimeout, clearTimeout, setInterval, clearInterval, Promise, Date: SandboxDate, Math, JSON,
    Number, String, Object, Array, RegExp, Error, TypeError, parseInt, parseFloat, isNaN,
    decodeURIComponent, encodeURIComponent, isFinite,
    navigator: { userAgent: 'node-test', maxTouchPoints: 0, vibrate() { }, clipboard: null },
    localStorage: {
        getItem: (k) => (k in lsData ? lsData[k] : null),
        setItem: (k, v) => { lsData[k] = String(v); },
        removeItem: (k) => { delete lsData[k]; },
        clear: () => { Object.keys(lsData).forEach((k) => delete lsData[k]); },
    },
    location: { origin: 'http://localhost', protocol: 'http:', href: 'http://localhost/' },
    document: {
        cookie: '', readyState: 'complete', head: makeEl('head'), body: makeEl('body'),
        documentElement: makeEl('html'),
        createElement: (t) => makeEl(t),
        getElementById: (id) => { if (!idCache.has(id)) { const e = makeEl('div'); e.id = id; idCache.set(id, e); } return idCache.get(id); },
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener: (type, fn) => { if (docListeners[type]) docListeners[type].push(fn); },
        removeEventListener() { },
    },
    matchMedia: () => ({ matches: false, addEventListener() { }, addListener() { } }),
    confirm: () => true,
    alert: () => { },
    addEventListener() { }, removeEventListener() { },
    requestAnimationFrame: (fn) => setTimeout(fn, 16), cancelAnimationFrame() { },
    getSelection: () => ({ removeAllRanges() { }, addRange() { } }),
    scrollTo() { },
};
sandbox.window = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);

let bootError = null;
try {
    vm.runInContext(scripts[0], sandbox, { filename: 'license.js' });
    vm.runInContext(scripts[1], sandbox, { filename: 'app.js' });
} catch (e) { bootError = e; }

section('Запуск приложения в DOM');
ok(!bootError, 'оба скрипта исполнились без ошибок' + (bootError ? ': ' + bootError.message : ''));
ok(!!sandbox.UZI && typeof sandbox.UZI.parseText === 'function', 'приложение опубликовало window.UZI');
ok(typeof sandbox.UZI.exportPdf === 'function' && typeof sandbox.UZI.saveState === 'function', 'API приложения доступно');
const lic = sandbox.__LIC;
ok(lic && typeof lic.activate === 'function', 'модуль лицензии опубликовал window.__LIC');

/* ============================== 3. Триал ============================== */
section('Пробный период');
await lic.refresh();
const deviceId = lic.status.deviceId;
ok(lic.status.state === 'trial' && lic.status.canUse === true, 'при первом запуске активен триал: ' + lic.status.state);
ok(lic.status.daysLeft === 3, 'триал = 3 дня, показано: ' + lic.status.daysLeft);
ok(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/.test(deviceId), 'ID устройства: ' + deviceId);

/* ====================== 4. Блокировка экспорта ======================== */
section('Блокировка экспорта');
function simulateClick(elementId) {
    const target = sandbox.document.getElementById(elementId);
    const evt = {
        target, preventDefault() { evt.defaultPrevented = true; },
        stopPropagation() { evt.stopped = true; },
        stopImmediatePropagation() { evt.stopped = true; },
        defaultPrevented: false, stopped: false,
    };
    docListeners.click.forEach((fn) => { try { fn(evt); } catch (e) { } });
    return evt;
}
ok(docListeners.click.length > 0, 'перехватчик кликов зарегистрирован (capture-фаза)');

let evt = simulateClick('pdfBtn');
ok(evt.defaultPrevented === false, 'в триале экспорт PDF разрешён');

/* — прокрутка часов на 5 дней: триал истёк — */
clockOffset = 5 * 86400000;
await lic.refresh();
ok(lic.status.state === 'expired' && lic.status.canUse === false, 'через 5 дней триал истёк: ' + lic.status.state);

evt = simulateClick('pdfBtn');
ok(evt.defaultPrevented === true, 'после триала экспорт PDF заблокирован');
evt = simulateClick('snapshotBtn');
ok(evt.defaultPrevented === true, 'после триала сохранение в историю заблокировано');
ok(sandbox.document.getElementById('licModal')._classes.has('active'), 'открылось окно активации');

/* — перевод часов назад — */
clockOffset = -86400000;
await lic.refresh();
ok(lic.status.tampered === true && lic.status.canUse === false, 'обнаружен перевод часов назад');

/* ============================ 5. Активация ============================ */
section('Активация ключом');
clockOffset = 0;
lsData && Object.keys(lsData).forEach((k) => delete lsData[k]);
sandbox.document.cookie = '';
await lic.refresh();
const dev2 = lic.status.deviceId;

const issue = (args) => {
    const out = execFileSync('node', ['tools/keygen.mjs', 'issue', ...args], { encoding: 'utf8' });
    return (out.match(/UZI1-[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/) || [])[0];
};
const good = issue(['--device', dev2, '--months', '12', '--name', 'Иванова М.П.']);
ok(!!good, 'выпущен ключ для устройства ' + dev2);

const res = await lic.activate(good);
ok(res.ok === true, 'активация корректным ключом прошла');
ok(lic.status.state === 'active' && lic.status.canUse === true, 'состояние active, canUse=true');
ok(lic.status.owner === 'Иванова М.П.', 'прочитано имя владельца: ' + lic.status.owner);
ok(lic.status.daysLeft > 360, 'срок ~1 год, дней: ' + lic.status.daysLeft);

evt = simulateClick('pdfBtn');
ok(evt.defaultPrevented === false, 'после активации экспорт снова разрешён');

const other = issue(['--device', 'ZZZZ-ZZZZ-ZZZZ-ZZZZ', '--months', '12']);
const resOther = await lic.activate(other);
ok(resOther.ok === false, 'ключ от другого устройства отклонён');

const tampered = good.slice(0, -4) + 'AAAA';
const resTamper = await lic.activate(tampered);
ok(resTamper.ok === false, 'подделанная подпись отклонена');
ok(lic.status.state === 'active', 'после неудачных попыток лицензия осталась активной');

/* ======================= 6. Совместимость WebCrypto =================== */
section('Криптография');
const pub = JSON.parse(readFileSync('keys/public.json', 'utf8')).jwk;
const b64urlBytes = (s) => {
    const t = s.replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(t + '='.repeat((4 - (t.length % 4)) % 4), 'base64');
};
const body = good.slice('UZI1-'.length);
const [payloadB64, sigB64] = body.split('.');
const key = await webcrypto.subtle.importKey('jwk', pub, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
const valid = await webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key,
    b64urlBytes(sigB64), new TextEncoder().encode(payloadB64));
ok(valid, 'подпись проверяется браузерным алгоритмом (WebCrypto ECDSA P-256)');

/* ======================= 7. Офлайн-артефакты ========================== */
section('Офлайн и правки');
['docs/sw.js', 'docs/manifest.webmanifest', 'docs/favicon.png', 'docs/icon-192.png', 'docs/icon-512.png', 'docs/vendor/html2pdf.bundle.min.js', 'docs/.nojekyll']
    .forEach((f) => ok(existsSync(f), 'есть ' + f));
ok(html.includes('./manifest.webmanifest'), 'манифест подключён файлом');
ok(html.includes('ГолосУЗИ') && html.includes('UZD Voce'), 'название «ГолосУЗИ (UZD Voce)» в разметке');
ok(html.includes('rel="icon"') && html.includes('./favicon.png'), 'фавикон подключён');
ok(html.includes('apple-touch-icon') && html.includes('./icon-192.png'), 'apple-touch-icon подключён');
ok(readFileSync('docs/manifest.webmanifest', 'utf8').includes('ГолосУЗИ'), 'название в PWA-манифесте');
ok(readFileSync('docs/manifest.webmanifest', 'utf8').includes('icon-512.png'), 'иконки 192/512 в PWA-манифесте');
ok(!html.includes('URL.createObjectURL(blob)).catch'), 'Service Worker регистрируется из файла');
ok(!readFileSync('docs/sw.js', 'utf8').includes('__BUILD_ID__'), 'версия Service Worker проставлена сборкой');
ok(scripts[1].includes('placentaEdge') && scripts[1].includes('umbilicalVessels2'), 'несохраняемые поля добавлены в сохранение');

console.log('\n  ' + (fail === 0 ? '══ ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ ══' : '══ ПРОВАЛЕНО: ' + fail + ' ══') + '\n');
process.exit(fail === 0 ? 0 : 1);
