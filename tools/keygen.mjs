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

function cmdIssue(args) {
  const privateKey = loadPrivateKey();

  const devices = [args.device, args.device2]
    .filter((d) => d && d !== true)
    .map(normalizeDevice)
    .filter(Boolean);
  if (!devices.length) {
    fail('Укажите хотя бы одно устройство:  --device ABCD-EFGH-JKLM-NPQR\n' +
         '     (клиент видит этот ID на экране «Активация» в программе)');
  }
  for (const d of devices) {
    if (d.length !== 16) fail(`Некорректный ID устройства «${d}» (ожидается 16 символов).`);
  }
  if (devices.length > 2) fail('Одна лицензия поддерживает не более 2 устройств.');

  let days;
  if (args.days) days = parseInt(args.days, 10);
  else if (args.months) days = Math.round(parseFloat(args.months) * 30.4375);
  else if (args.years) days = Math.round(parseFloat(args.years) * 365.25);
  else days = 365;
  if (!Number.isFinite(days) || days <= 0) fail('Некорректный срок (--days / --months / --years).');

  const type = (args.type === 'trial') ? 'trial' : 'paid';
  const now = Date.now();
  const exp = now + days * 86400000;

  const payload = {
    v: 1,
    t: type,
    d: devices,
    exp,
    iat: now,
    n: typeof args.name === 'string' ? args.name : '',
    s: randomBytes(4).toString('hex'),
  };

  const token = makeToken(payload, privateKey);
  const kind = type === 'trial' ? 'ПРОБНЫЙ' : 'ЛИЦЕНЗИЯ';

  console.log('\n  ✔ ' + kind + ' ключ выпущен');
  console.log('  ─────────────────────────────────────────────');
  console.log('  Устройства : ' + devices.join(', '));
  console.log('  Владелец   : ' + (payload.n || '—'));
  console.log('  Действует  : до ' + fmtDate(exp) + '  (' + days + ' дн.)');
  console.log('  ─────────────────────────────────────────────');
  console.log('\n  Ключ для клиента (скопируйте целиком):\n');
  console.log(token);
  console.log('\n  Готовый текст письма:\n');
  console.log('  Здравствуйте!');
  console.log('  Ваш ключ активации программы «ГолосУЗИ (UZD Voce)»:\n');
  console.log('  ' + token);
  console.log('\n  Откройте программу → «Активация» → вставьте ключ → «Активировать».');
  console.log('  Срок действия — до ' + fmtDate(exp) + '. Ключ привязан к вашему устройству.\n');
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
  case 'verify': cmdVerify(args); break;
  case 'inspect': cmdInspect(args); break;
  default:
    console.log(`
  keygen.mjs — выпуск лицензионных ключей

    node tools/keygen.mjs init
    node tools/keygen.mjs issue --device ABCD-EFGH-JKLM-NPQR --months 12 --name "ФИО"
    node tools/keygen.mjs issue --device ABCD-... --days 3 --type trial
    node tools/keygen.mjs verify --token "UZI1-..." [--device ABCD-...]
    node tools/keygen.mjs inspect --token "UZI1-..."
`);
}
