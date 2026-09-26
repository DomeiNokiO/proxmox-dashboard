// src/auth.js — Autentikasi login dashboard yang aman (tanpa dependency eksternal)
// - Password di-hash dengan scrypt (salt acak) — TIDAK pernah disimpan plaintext.
// - Sesi = cookie httpOnly, SameSite=Strict, ditandatangani HMAC-SHA256 + kedaluwarsa.
// - Perbandingan tahan-timing (timingSafeEqual) untuk cegah timing attack.
// - Rate-limit login per-IP untuk hambat brute force.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SCRYPT_N = 16384; // biaya CPU/memori
const KEYLEN = 64;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 jam

// ---- Hash password (scrypt) ----
export function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(String(plain), salt, KEYLEN, { N: SCRYPT_N });
  return `scrypt$${SCRYPT_N}$${salt.toString('hex')}$${dk.toString('hex')}`;
}

export function verifyPassword(plain, stored) {
  try {
    if (!stored || !stored.startsWith('scrypt$')) return false;
    const [, nStr, saltHex, hashHex] = stored.split('$');
    const N = parseInt(nStr, 10) || SCRYPT_N;
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const dk = crypto.scryptSync(String(plain), salt, expected.length, { N });
    return crypto.timingSafeEqual(dk, expected);
  } catch { return false; }
}

// ---- Rahasia sesi: dari env atau di-generate & disimpan (agar install mulus) ----
export function loadSessionSecret() {
  if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 16) {
    return process.env.SESSION_SECRET;
  }
  const secretFile = path.join(__dirname, '..', '.session-secret');
  try {
    if (fs.existsSync(secretFile)) {
      const s = fs.readFileSync(secretFile, 'utf8').trim();
      if (s.length >= 16) return s;
    }
    const gen = crypto.randomBytes(48).toString('hex');
    fs.writeFileSync(secretFile, gen, { mode: 0o600 });
    return gen;
  } catch {
    // Fallback: rahasia in-memory (sesi tak persist antar restart)
    return crypto.randomBytes(48).toString('hex');
  }
}

// ---- Sesi bertandatangan: base64(payload).hmac ----
export class SessionManager {
  constructor(secret) { this.secret = secret; }

  sign(payloadObj) {
    const payload = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
    const mac = crypto.createHmac('sha256', this.secret).update(payload).digest('base64url');
    return `${payload}.${mac}`;
  }

  verify(token) {
    if (!token || typeof token !== 'string' || !token.includes('.')) return null;
    const [payload, mac] = token.split('.');
    const expected = crypto.createHmac('sha256', this.secret).update(payload).digest('base64url');
    const a = Buffer.from(mac || '');
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try {
      const obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (!obj.exp || Date.now() > obj.exp) return null;
      return obj;
    } catch { return null; }
  }

  create(username) {
    return this.sign({ u: username, iat: Date.now(), exp: Date.now() + SESSION_TTL_MS });
  }
}

// ---- Parse cookie header ----
export function parseCookies(req) {
  const out = {};
  const raw = req.headers?.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// ---- Rate limiter login sederhana (per IP, in-memory) ----
export class LoginRateLimiter {
  constructor({ max = 8, windowMs = 15 * 60 * 1000, lockMs = 15 * 60 * 1000 } = {}) {
    this.max = max; this.windowMs = windowMs; this.lockMs = lockMs;
    this.hits = new Map(); // ip -> { count, first, lockUntil }
  }

  check(ip) {
    const now = Date.now();
    const e = this.hits.get(ip);
    if (e && e.lockUntil && now < e.lockUntil) {
      return { allowed: false, retryMs: e.lockUntil - now };
    }
    return { allowed: true };
  }

  fail(ip) {
    const now = Date.now();
    let e = this.hits.get(ip);
    if (!e || now - e.first > this.windowMs) e = { count: 0, first: now, lockUntil: 0 };
    e.count += 1;
    if (e.count >= this.max) e.lockUntil = now + this.lockMs;
    this.hits.set(ip, e);
  }

  reset(ip) { this.hits.delete(ip); }
}

export const SESSION_COOKIE = 'pvedash_session';
export { SESSION_TTL_MS };
