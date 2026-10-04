#!/usr/bin/env node
/**
 * build.mjs — сборка релиза в docs/ (папка для GitHub Pages).
 *
 * Что делает:
 *   1. Читает исходник UZD.html.
 *   2. Внедряет модуль лицензирования (src/license.js + license.css + activation.html),
 *      подставляя публичный ключ из keys/public.json.
 *   3. Минифицирует JS приложения (terser) и обфусцирует модуль лицензии
 *      (javascript-obfuscator), минифицирует HTML/CSS (html-minifier-terser).
 *   4. Локально вендорит html2pdf.js, чтобы PDF работал офлайн.
 *   5. Генерирует docs/index.html, docs/sw.js, docs/manifest.webmanifest, docs/icon.svg.
 *
 * Запуск:
 *   npm run build            — полная сборка (минификация + обфускация)
 *   node tools/build.mjs --dev    — без минификации (для отладки)
 *   node tools/build.mjs --no-obfuscate
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { minify as terserMinify } from 'terser';
import { minify as htmlMinify } from 'html-minifier-terser';
import JavaScriptObfuscator from 'javascript-obfuscator';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const DOCS = path.join(ROOT, 'docs');
const TMP = path.join(ROOT, '.tmp');
const KEYS = path.join(ROOT, 'keys');

const ARGS = process.argv.slice(2);
const DEV = ARGS.includes('--dev');
const NO_OBF = ARGS.includes('--no-obfuscate') || DEV;

const HTML2PDF_URL = 'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js';
const HTML2PDF_REL = './vendor/html2pdf.bundle.min.js';

const APP_JS_TOKEN = '__UZI_APP_JS__';
const LIC_JS_TOKEN = '__UZI_LIC_JS__';

/* ---------------------------------------------------------------- helpers */

function log(step, msg) { console.log('  ' + step.padEnd(12) + msg); }
function kb(n) { return (n / 1024).toFixed(1) + ' КБ'; }
function must(cond, msg) { if (!cond) { console.error('\n  ✖ ' + msg + '\n'); process.exit(1); } }

function readPublicJwk() {
    const p = path.join(KEYS, 'public.json');
    must(existsSync(p), 'Не найден keys/public.json. Выполните:  npm run keys:init');
    const data = JSON.parse(readFileSync(p, 'utf8'));
    must(data.jwk && data.jwk.kty === 'EC', 'Некорректный публичный ключ в keys/public.json');
    return data.jwk;
}

async function vendorHtml2pdf() {
    const dir = path.join(DOCS, 'vendor');
    const out = path.join(dir, 'html2pdf.bundle.min.js');
    const cache = path.join(TMP, 'html2pdf.bundle.min.js');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    if (existsSync(cache)) {
        writeFileSync(out, readFileSync(cache));
        return true;
    }
    try {
        const res = await fetch(HTML2PDF_URL, { redirect: 'follow' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const buf = Buffer.from(await res.arrayBuffer());
        if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true });
        writeFileSync(cache, buf);
        writeFileSync(out, buf);
        return true;
    } catch (e) {
        console.warn('  ⚠ Не удалось скачать html2pdf.js (' + e.message + ').');
        console.warn('    PDF будет работать только при наличии интернета (CDN).');
        return false;
    }
}

/* ------------------------------------------------------------------ build */

async function build() {
    console.log('\n  Сборка «ГолосУЗИ (UZD Voce)»' + (DEV ? '  [dev]' : '') + '\n');

    const appHtmlPath = path.join(ROOT, 'UZD.html');
    must(existsSync(appHtmlPath), 'Не найден исходник UZD.html');

    const jwk = readPublicJwk();
    const buildId = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
    let html = readFileSync(appHtmlPath, 'utf8');
    const srcSize = Buffer.byteLength(html, 'utf8');

    /* 1. Извлекаем встроенный скрипт приложения */
    const scriptRe = /<script>([\s\S]*?)<\/script>/;
    const m = scriptRe.exec(html);
    must(m, 'Не найден встроенный <script> приложения в UZD.html');
    const appJs = m[1];
    html = html.replace(scriptRe, '<script>' + APP_JS_TOKEN + '</script>');

    /* 2. Вендорим html2pdf (локальная копия для офлайна) */
    const vendored = await vendorHtml2pdf();
    if (vendored) html = html.replace(HTML2PDF_URL, HTML2PDF_REL);

    /* 3. Внедряем CSS лицензии */
    const licenseCss = readFileSync(path.join(SRC, 'license.css'), 'utf8');
    html = html.replace('</style>', '</style>\n<style>\n' + licenseCss + '\n</style>');

    /* 4. Внедряем разметку окна активации */
    const activationHtml = readFileSync(path.join(SRC, 'activation.html'), 'utf8');
    const toastAnchor = '<div class="toast-wrap" id="toastWrap"';
    must(html.includes(toastAnchor), 'Не найден якорь .toast-wrap для окна активации');
    html = html.replace(toastAnchor, activationHtml + '\n' + toastAnchor);

    /* 5. Внедряем скрипт лицензии (перед скриптом приложения) */
    html = html.replace('<script>' + APP_JS_TOKEN + '</script>',
        '<script>' + LIC_JS_TOKEN + '</script>\n<script>' + APP_JS_TOKEN + '</script>');

    /* 6. Минификация HTML/CSS (скрипты подставляются после) */
    let outHtml = html;
    if (!DEV) {
        outHtml = await htmlMinify(outHtml, {
            collapseWhitespace: true,
            conservativeCollapse: true,
            removeComments: true,
            minifyCSS: true,
            minifyJS: false,
            keepClosingSlash: true,
            caseSensitive: true,
            removeAttributeQuotes: false,
            collapseBooleanAttributes: true,
            useShortDoctype: true,
        });
    }

    /* 7. Приложение -> terser */
    let appOut = appJs;
    if (!DEV) {
        const res = await terserMinify(appJs, {
            ecma: 2020,
            compress: { passes: 2, drop_debugger: true, pure_funcs: ['console.log'] },
            mangle: true,
            format: { comments: false, ascii_only: false },
        });
        must(res.code, 'terser не вернул результат для скрипта приложения');
        appOut = res.code;
    }

    /* 8. Модуль лицензии -> подстановка ключа + обфускация */
    let licJs = readFileSync(path.join(SRC, 'license.js'), 'utf8');
    must(licJs.includes('__UZI_PUBLIC_JWK__'), 'В src/license.js не найден маркер __UZI_PUBLIC_JWK__');
    licJs = licJs.replace('__UZI_PUBLIC_JWK__', JSON.stringify(jwk));

    let licOut = licJs;
    if (!NO_OBF) {
        const JO = JavaScriptObfuscator.default || JavaScriptObfuscator;
        licOut = JO.obfuscate(licJs, {
            compact: true,
            target: 'browser',
            identifierNamesGenerator: 'hexadecimal',
            renameGlobals: false,
            stringArray: true,
            stringArrayEncoding: ['rc4'],
            stringArrayThreshold: 1,
            rotateStringArray: true,
            stringArrayWrappersCount: 1,
            splitStrings: false,
            numbersToExpressions: false,
            simplify: true,
            controlFlowFlattening: true,
            controlFlowFlatteningThreshold: 0.15,
            deadCodeInjection: false,
            selfDefending: false,
            disableConsoleOutput: false,
            unicodeEscapeSequence: false,
        }).getObfuscatedCode();
    }

    must(outHtml.includes(APP_JS_TOKEN), 'Маркер скрипта приложения потерян при минификации HTML');
    must(outHtml.includes(LIC_JS_TOKEN), 'Маркер скрипта лицензии потерян при минификации HTML');
    outHtml = outHtml.replace(LIC_JS_TOKEN, () => licOut);
    outHtml = outHtml.replace(APP_JS_TOKEN, () => appOut);

    /* 9. Пишем артефакты */
    if (!existsSync(DOCS)) mkdirSync(DOCS, { recursive: true });
    writeFileSync(path.join(DOCS, 'index.html'), outHtml);

    writeFileSync(path.join(DOCS, 'sw.js'),
        readFileSync(path.join(SRC, 'sw.js'), 'utf8').replaceAll('__BUILD_ID__', buildId));
    writeFileSync(path.join(DOCS, 'manifest.webmanifest'), JSON.stringify({
        name: 'ГолосУЗИ (UZD Voce) · Приказ 1130н',
        short_name: 'ГолосУЗИ',
        description: 'Голосовой протокол скринингового УЗИ по приказу МЗ РФ № 1130н',
        start_url: './',
        scope: './',
        display: 'standalone',
        orientation: 'any',
        background_color: '#f5f6fb',
        theme_color: '#6366f1',
        lang: 'ru',
        icons: [
            { src: './icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: './icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
            { src: './icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
    }, null, 2) + '\n');

    writeFileSync(path.join(DOCS, '.nojekyll'), '');

    /* Иконки из assets/ (favicon для вкладки + 192/512 для PWA). */
    const iconFiles = ['favicon.png', 'icon-192.png', 'icon-512.png'];
    const copiedIcons = [];
    for (const name of iconFiles) {
        const from = path.join(ROOT, 'assets', name);
        if (existsSync(from)) { writeFileSync(path.join(DOCS, name), readFileSync(from)); copiedIcons.push(name); }
    }

    const outSize = Buffer.byteLength(outHtml, 'utf8');
    const diffPct = Math.round((1 - outSize / srcSize) * 100);
    console.log('');
    log('Исходник', kb(srcSize));
    log('HTML', kb(outSize));
    log('  · скрипт приложения', kb(Buffer.byteLength(appOut, 'utf8')));
    log('  · модуль лицензии', kb(Buffer.byteLength(licOut, 'utf8')) + (NO_OBF ? '  (без обфускации)' : '  (обфусцирован)'));
    log('Иконки', copiedIcons.length ? copiedIcons.join(', ') : 'не найдены в assets/');
    log('Готово', 'docs/index.html  ' + kb(outSize) + '  (' +
        (diffPct >= 0 ? diffPct + '% меньше' : Math.abs(diffPct) + '% больше') + ' исходника)');
    console.log('\n  Артефакты: docs/index.html, docs/sw.js, docs/manifest.webmanifest' +
        (copiedIcons.length ? ', docs/' + copiedIcons.join(', docs/') : '') +
        (vendored ? ', docs/vendor/html2pdf.bundle.min.js' : ''));
    if (!copiedIcons.length) console.warn('  ⚠ Иконки не найдены в assets/ — favicon и иконки PWA не скопированы.');
    console.log('  Проверить локально:  npm run serve  →  http://localhost:8080\n');
}

build().catch((e) => { console.error('\n  ✖ Ошибка сборки:', e); process.exit(1); });
