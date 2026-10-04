#!/usr/bin/env node
/**
 * serve.mjs — простой статический сервер для локальной проверки docs/.
 * Запуск:  npm run serve   →   http://localhost:8080
 *
 * Важно: проверять лицензию и Service Worker нужно по http(s), а не через
 * file:// — иначе недоступен WebCrypto (crypto.subtle).
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'docs');
const PORT = Number(process.env.PORT) || 8080;

const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
};

const server = createServer(async (req, res) => {
    try {
        let urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
        if (urlPath === '/' || urlPath === '') urlPath = '/index.html';
        const filePath = path.join(ROOT, urlPath);
        if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }
        const info = await stat(filePath);
        if (info.isDirectory()) { res.writeHead(302, { Location: urlPath + '/index.html' }); return res.end(); }
        const body = await readFile(filePath);
        res.writeHead(200, {
            'Content-Type': TYPES[path.extname(filePath)] || 'application/octet-stream',
            'Cache-Control': 'no-cache',
            'Service-Worker-Allowed': '/',
        });
        res.end(body);
    } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 Not Found');
    }
});

server.listen(PORT, () => {
    console.log('\n  Сервер запущен:  http://localhost:' + PORT);
    console.log('  Папка: ' + ROOT);
    console.log('  Остановить: Ctrl+C\n');
});
