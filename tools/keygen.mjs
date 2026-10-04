#!/usr/bin/env node
/**
 * keygen.mjs — инструмент ВЛАДЕЛЬЦА программы для выпуска лицензионных ключей.
 *
 * Приватный ключ подписи создаётся здесь и остаётся только на вашем компьютере
 * (keys/private.pem, добавлен в .gitignore). Публичный ключ вшивается в сайт.
 *
 * Команды:
 *   node tools/keygen.mjs init
 *       Создать пару ключей P-256. Публичный ключ -> keys/public.json,
 *       приватный -> keys/private.pem (НИКОГДА не публиковать!).
 *
 *   node tools/keygen.mjs issue --device ABCD-EFGH-JKLM-NPQR [--device2 ...] \
 *                               --months 12 --name "Иванова М.П."
 *       Выпустить ключ на 1 год для 1–2 устройств.
 *
 *   node tools/keygen.mjs issue --device ABCD-... --days 3 --type trial
 *       Выпустить пробный ключ на 3 дня.
 *
 *   node tools/keygen.mjs verify --token "UZI1-..." [--device ABCD-...]
 *       Проверить ключ и (необязательно) принадлежность устройству.
 *
 *   node tools/keygen.mjs inspect --token "UZI1-..."
 *       Показать содержимое ключа без проверки подписи.
 */

import {
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  randomBytes,
} from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin as rlInput, stdout as rlOutput } from 'node:process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEYS_DIR = path.join(ROOT, 'keys');
const PRIVATE_PATH = path.join(KEYS_DIR, 'private.pem');
const PUBLIC_PATH = path.join(KEYS_DIR, 'public.json');

const TOKEN_PREFIX = 'UZI1-';
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/* ------------------------- утилиты ------------------------- */

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}
function fmtDate(ms) {
  return new Date(ms).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
}
function fail(msg) {
  console.error('\n  ✖ ' + msg + '\n');
  process.exit(1);
}

/* --------------------------- init --------------------------- */

function cmdInit(args) {
  if (!existsSync(KEYS_DIR)) mkdirSync(KEYS_DIR, { recursive: true });
  if (existsSync(PRIVATE_PATH) && !args.force) {
    fail('Ключи уже существуют: keys/private.pem\n' +
         '     Если вы уверены, что хотите ПЕРЕСОЗДАТЬ пару (все ранее выданные\n' +
         '     ключи перестанут работать!), запустите с флагом --force.');
  }

  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const jwk = publicKey.export({ format: 'jwk' });

  writeFileSync(PRIVATE_PATH, privPem, { mode: 0o600 });
  writeFileSync(PUBLIC_PATH, JSON.stringify({
    alg: 'ECDSA',
    crv: 'P-256',
    created: new Date().toISOString(),
    jwk,
  }, null, 2) + '\n');

  console.log('\n  ✔ Пара ключей создана.');
  console.log('    Приватный (ХРАНИТЬ В ТАЙНЕ): ' + path.relative(ROOT, PRIVATE_PATH));
  console.log('    Публичный (вшивается в сайт): ' + path.relative(ROOT, PUBLIC_PATH));
  console.log('\n  ВАЖНО: сделайте резервную копию keys/private.pem.');
  console.log('  Если потеряете его — не сможете выпускать новые ключи.');
  console.log('  Если утечёт — любой сможет подделать лицензии.\n');
}

/* --------------------------- issue -------------------------- */

function loadPrivateKey() {
  if (!existsSync(PRIVATE_PATH)) {
    fail('Не найден приватный ключ keys/private.pem.\n' +
         '     Сначала выполните:  node tools/keygen.mjs init');
  }
  return createPrivateKey(readFileSync(PRIVATE_PATH, 'utf8'));
}

function normalizeDevice(id) {
  return String(id).toUpperCase().replace(/[^0-9A-Z]/g, '');
}

function makeToken(payload, privateKey) {
  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const signature = cryptoSign('sha256', Buffer.from(payloadB64, 'utf8'), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363', // 64-байтная подпись r||s — тот же формат, что и в WebCrypto
  });
  return TOKEN_PREFIX + payloadB64 + '.' + b64url(signature);
}

/* Выпуск ключа: общее ядро для командной строки и интерактивного мастера. */
function issueCore({ devices, days, type, name }) {
  const privateKey = loadPrivateKey();

  const list = (devices || []).map(normalizeDevice).filter(Boolean);
  if (!list.length) {
    fail('Укажите хотя бы одно устройство:  --device ABCD-EFGH-JKLM-NPQR\n' +
         '     (клиент видит этот ID на экране «Активация» в программе)');
  }
  for (const d of list) {
    if (d.length !== 16) fail(`Некорректный ID устройства «${d}» (ожидается 16 символов).`);
  }
  if (list.length > 2) fail('Одна лицензия поддерживает не более 2 устройств.');
  if (!Number.isFinite(days) || days <= 0) fail('Некорректный срок.');

  const kind = type === 'trial' ? 'trial' : 'paid';
  const now = Date.now();
  const exp = now + days * 86400000;

  const payload = {
    v: 1,
    t: kind,
    d: list,
    exp,
    iat: now,
    n: typeof name === 'string' ? name : '',
    s: randomBytes(4).toString('hex'),
  };

  return { token: makeToken(payload, privateKey), payload, devices: list, days, type: kind, exp };
}

/* Текст письма клиенту. */
function letterText(res) {
  return 'Здравствуйте!\n' +
    'Ваш ключ активации программы «ГолосУЗИ (UZD Voce)»:\n\n' +
    res.token + '\n\n' +
    'Откройте программу → «Активация» → вставьте ключ → «Активировать».\n' +
    'Срок действия — до ' + fmtDate(res.exp) + '. Ключ привязан к вашему устройству.';
}

function printIssue(res, savedPath) {
  const kind = res.type === 'trial' ? 'ПРОБНЫЙ' : 'ЛИЦЕНЗИЯ';
  console.log('\n  ✔ ' + kind + ' ключ выпущен');
  console.log('  ─────────────────────────────────────────────');
  console.log('  Устройства : ' + res.devices.join(', '));
  console.log('  Владелец   : ' + (res.payload.n || '—'));
  console.log('  Действует  : до ' + fmtDate(res.exp) + '  (' + res.days + ' дн.)');
  console.log('  ─────────────────────────────────────────────');
  console.log('\n  Ключ для клиента (скопируйте целиком):\n');
  console.log(res.token);
  console.log('\n  Готовый текст письма:\n');
  console.log(letterText(res).split('\n').map((l) => '  ' + l).join('\n'));
  if (savedPath) console.log('\n  Сохранено: ' + path.relative(ROOT, savedPath));
  console.log('');
}

/* Копирование в системный буфер обмена (не критично, при неудаче — молча пропускаем). */
function copyToClipboard(text) {
  try {
    if (process.platform === 'win32') execFileSync('clip', [], { input: text });
    else if (process.platform === 'darwin') execFileSync('pbcopy', [], { input: text });
    else execFileSync('xclip', ['-selection', 'clipboard'], { input: text });
    return true;
  } catch { return false; }
}

/* Сохранение копии письма в keys/issued/ (папка в .gitignore). */
function saveIssued(res) {
  try {
    const dir = path.join(KEYS_DIR, 'issued');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10);
    const file = path.join(dir, `${stamp}_${res.devices[0]}.txt`);
    writeFileSync(file, letterText(res) + '\n', 'utf8');
    return file;
  } catch { return null; }
}

function cmdIssue(args) {
  let days;
  if (args.days) days = parseInt(args.days, 10);
  else if (args.months) days = Math.round(parseFloat(args.months) * 30.4375);
  else if (args.years) days = Math.round(parseFloat(args.years) * 365.25);
  else days = 365;

  const res = issueCore({
    devices: [args.device, args.device2].filter((d) => d && d !== true),
    days,
    type: args.type,
    name: typeof args.name === 'string' ? args.name : '',
  });
  printIssue(res, saveIssued(res));
}

/* ------------------------ интерактивный мастер ------------------------ */

/* Надёжный ввод: буферизуем строки, чтобы не терять их при быстром вводе. */
function makePrompter() {
  const rl = createInterface({ input: rlInput, output: rlOutput, terminal: rlInput.isTTY });
  const queue = [];
  const waiters = [];
  let closed = false;
  rl.on('line', (line) => {
    if (waiters.length) waiters.shift()(line);
    else queue.push(line);
  });
  rl.on('close', () => {
    closed = true;
    while (waiters.length) waiters.shift()(null);
  });
  return {
    async ask(prompt) {
      rlOutput.write(prompt);
      if (queue.length) return queue.shift();
      if (closed) return null;
      return new Promise((resolve) => waiters.push(resolve));
    },
    close() { rl.close(); },
  };
}

async function cmdWizard() {
  if (!existsSync(PRIVATE_PATH)) {
    fail('Не найден приватный ключ keys/private.pem.\n' +
         '     Сначала выполните:  node tools/keygen.mjs init');
  }
  const io = makePrompter();
  const ask = async (prompt) => {
    const v = await io.ask(prompt);
    if (v === null) { console.log(''); fail('Ввод прерван.'); }
    return v;
  };
  try {
    console.log('\n  ┌─────────────────────────────────────────────┐');
    console.log('  │   ГолосУЗИ (UZD Voce) — выпуск ключа        │');
    console.log('  └─────────────────────────────────────────────┘\n');

    /* 1. Устройство(а) */
    let device = '';
    for (;;) {
      const ans = (await ask('  1) ID устройства клиента (XXXX-XXXX-XXXX-XXXX): ')).trim();
      if (normalizeDevice(ans).length === 16) { device = normalizeDevice(ans); break; }
      console.log('     ✖ Нужно 16 символов (буквы и цифры). Пример: PB27-S844-AQNB-JS9D\n');
    }

    let device2 = '';
    for (;;) {
      const ans = (await ask('  2) Второе устройство, ПК+телефон (Enter — нет): ')).trim();
      if (!ans) break;
      if (normalizeDevice(ans).length === 16) { device2 = normalizeDevice(ans); break; }
      console.log('     ✖ Нужно 16 символов или просто Enter.\n');
    }

    /* 3. Срок */
    console.log('\n  3) Срок действия:');
    console.log('     1 — 3 дня (пробный)');
    console.log('     2 — 6 месяцев');
    console.log('     3 — 1 год   (по умолчанию)');
    console.log('     4 — 2 года');
    console.log('     5 — свой срок в днях');
    let days = 365, type = 'paid';
    for (;;) {
      const ch = (await ask('     Выберите [1-5]: ')).trim();
      if (ch === '' || ch === '3') { days = 365; break; }
      if (ch === '1') { days = 3; type = 'trial'; break; }
      if (ch === '2') { days = Math.round(6 * 30.4375); break; }
      if (ch === '4') { days = Math.round(2 * 365.25); break; }
      if (ch === '5') {
        const d = parseInt((await ask('     Сколько дней: ')).trim(), 10);
        if (Number.isFinite(d) && d > 0) { days = d; break; }
        console.log('     ✖ Введите положительное число.\n');
        continue;
      }
      console.log('     ✖ Введите цифру от 1 до 5.\n');
    }

    /* 4. ФИО */
    const name = (await ask('\n  4) ФИО владельца (Enter — пропустить): ')).trim();

    /* Выпуск */
    const res = issueCore({ devices: [device, device2], days, type, name });
    const saved = saveIssued(res);
    const copied = copyToClipboard(res.token);
    printIssue(res, saved);
    console.log(copied
      ? '  Ключ скопирован в буфер обмена — вставьте его в письмо клиенту (Ctrl+V).\n'
      : '  (Ключ выше — скопируйте его вручную.)\n');
  } finally {
    io.close();
  }
}

/* -------------------------- verify -------------------------- */

function decodeToken(token) {
  const t = String(token).trim();
  if (!t.startsWith(TOKEN_PREFIX)) fail('Ключ должен начинаться с «' + TOKEN_PREFIX + '».');
  const body = t.slice(TOKEN_PREFIX.length);
  const dot = body.indexOf('.');
  if (dot < 0) fail('Повреждённый ключ: отсутствует подпись.');
  const payloadB64 = body.slice(0, dot);
  const sigB64 = body.slice(dot + 1);
  let payload;
  try { payload = JSON.parse(b64urlDecode(payloadB64).toString('utf8')); }
  catch { fail('Повреждённый ключ: не удалось прочитать данные.'); }
  return { payloadB64, sig: b64urlDecode(sigB64), payload };
}

function loadPublicKey() {
  if (!existsSync(PUBLIC_PATH)) fail('Не найден keys/public.json. Выполните: node tools/keygen.mjs init');
  return createPublicKey({ key: JSON.parse(readFileSync(PUBLIC_PATH, 'utf8')).jwk, format: 'jwk' });
}

function cmdVerify(args) {
  if (!args.token || args.token === true) fail('Укажите ключ:  --token "UZI1-..."');
  const { payloadB64, sig, payload } = decodeToken(args.token);
  const ok = cryptoVerify('sha256', Buffer.from(payloadB64, 'utf8'), {
    key: loadPublicKey(),
    dsaEncoding: 'ieee-p1363',
  }, sig);

  console.log('\n  Подпись      : ' + (ok ? '✔ действительна' : '✖ НЕВЕРНА'));
  console.log('  Тип          : ' + (payload.t === 'trial' ? 'пробный' : 'лицензия'));
  console.log('  Владелец     : ' + (payload.n || '—'));
  console.log('  Устройства   : ' + (payload.d || []).join(', '));
  console.log('  Действует до : ' + fmtDate(payload.exp) +
    (Date.now() > payload.exp ? '  (ИСТЁК)' : '  (осталось ' + Math.ceil((payload.exp - Date.now()) / 86400000) + ' дн.)'));

  if (args.device && args.device !== true) {
    const dev = normalizeDevice(args.device);
    const match = (payload.d || []).includes(dev);
    console.log('  Устройство   : ' + (match ? '✔ входит в лицензию' : '✖ НЕ входит в лицензию'));
  }
  console.log('');
  if (!ok) process.exitCode = 1;
}

function cmdInspect(args) {
  if (!args.token || args.token === true) fail('Укажите ключ:  --token "UZI1-..."');
  const { payload } = decodeToken(args.token);
  console.log(JSON.stringify(payload, null, 2));
}

/* --------------------------- main --------------------------- */

const argv = process.argv.slice(2);
const command = argv[0];
const args = parseArgs(argv.slice(1));

switch (command) {
  case 'init': cmdInit(args); break;
  case 'issue': cmdIssue(args); break;
  case 'wizard': await cmdWizard(); break;
  case 'verify': cmdVerify(args); break;
  case 'inspect': cmdInspect(args); break;
  default:
    console.log(`
  keygen.mjs — выпуск лицензионных ключей

    node tools/keygen.mjs wizard
        Интерактивный мастер: отвечаете на вопросы — получаете готовый ключ.

    node tools/keygen.mjs init
    node tools/keygen.mjs issue --device ABCD-EFGH-JKLM-NPQR --months 12 --name "ФИО"
    node tools/keygen.mjs issue --device ABCD-... --days 3 --type trial
    node tools/keygen.mjs verify --token "UZI1-..." [--device ABCD-...]
    node tools/keygen.mjs inspect --token "UZI1-..."
`);
}
