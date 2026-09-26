#!/usr/bin/env node
// scripts/set-password.mjs — Set/ganti kredensial login dashboard secara AMAN & interaktif.
// Password diketik di prompt (tersembunyi di TTY), di-hash scrypt, ditulis ke .env.
// TIDAK perlu menyalin-tempel hash panjang. Jalankan: npm run set-password
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../src/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(__dirname, '..', '.env');
const isTTY = !!process.stdin.isTTY;

// Satu interface readline dipakai sepanjang sesi (aman untuk input pipe non-TTY).
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: isTTY });

let maskNext = false;
if (isTTY) {
  const origWrite = rl._writeToOutput.bind(rl);
  rl._writeToOutput = (str) => {
    if (maskNext && str && !str.includes('\n') && !str.includes('?') && !str.includes(':')) {
      rl.output.write('*');
    } else {
      origWrite(str);
    }
  };
}

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    maskNext = hidden && isTTY;
    rl.question(question, (answer) => {
      if (maskNext) rl.output.write('\n');
      maskNext = false;
      resolve(answer.trim());
    });
  });
}

function readEnvLines() {
  try { return fs.readFileSync(ENV_PATH, 'utf8').split('\n'); } catch { return []; }
}
function upsert(lines, key, value) {
  let found = false;
  const out = lines.map((l) => (l.startsWith(`${key}=`) ? (found = true, `${key}=${value}`) : l));
  if (!found) out.push(`${key}=${value}`);
  return out;
}
function removeKey(lines, key) {
  return lines.filter((l) => !l.startsWith(`${key}=`));
}

async function main() {
  console.log('\n=== Set kredensial login Dashboard Proxmox ===\n');

  const username = (await ask('Username admin [admin]: ')) || 'admin';

  let password;
  for (;;) {
    password = await ask('Password baru (min. 8 karakter): ', { hidden: true });
    if (!password || password.length < 8) {
      console.log('  x Password minimal 8 karakter. Ulangi.\n');
      continue;
    }
    const confirm = await ask('Ulangi password: ', { hidden: true });
    if (password !== confirm) {
      console.log('  x Konfirmasi tidak cocok. Ulangi.\n');
      continue;
    }
    break;
  }
  rl.close();

  const hash = hashPassword(password);
  let lines = readEnvLines();
  lines = removeKey(lines, 'DASHBOARD_PASSWORD');
  lines = removeKey(lines, 'DASHBOARD_PASSWORD_HASH');
  lines = upsert(lines, 'DASHBOARD_USER', username);
  lines = upsert(lines, 'DASHBOARD_PASSWORD_HASH', hash);
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  fs.writeFileSync(ENV_PATH, lines.join('\n') + '\n', { mode: 0o640 });

  console.log('\n  OK Kredensial tersimpan (password sebagai hash scrypt, TIDAK plaintext).');
  console.log(`  OK Username : ${username}`);
  console.log(`  OK File     : ${ENV_PATH}`);
  console.log('\n  Restart service agar berlaku:');
  console.log('    systemctl restart proxmox-dashboard\n');
}

main().catch((e) => { console.error('Gagal:', e.message); process.exit(1); });
