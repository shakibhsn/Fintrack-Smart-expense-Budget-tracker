#!/usr/bin/env node
// Verified PostgreSQL backup.   DATABASE_URL=postgresql://... node scripts/db-backup.js [--out ./backups]
//
//  * READ-ONLY on the database (pg_dump only reads). Custom format (-Fc): compressed, restorable selectively with pg_restore.
//  * Verifies what it wrote: the file is not empty, `pg_restore --list` can read it, and the table of contents contains the core tables.
//  * Writes <name>.sha256 next to the dump so a copy can be checked later.
//  * The password is passed to pg_dump through the PGPASSWORD environment variable (never on the command line, never printed).
//  * Finds the PostgreSQL client tools on PATH, or in PG_BIN (e.g. "C:\Program Files\PostgreSQL\17\bin").
// A backup is only trusted once it has been RESTORED somewhere: run scripts/db-verify-restore.js on it (see docs/deployment/BACKUP_RESTORE.md).
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const bin = (name) => (process.env.PG_BIN ? path.join(process.env.PG_BIN, process.platform === 'win32' ? `${name}.exe` : name) : name);
const run = (cmd, args, env) => spawnSync(cmd, args, { env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

const url = process.env.DATABASE_URL;
if (!url) { console.error('Set DATABASE_URL to the database to back up.'); process.exit(2); }
const u = new URL(url);
const db = decodeURIComponent(u.pathname.replace(/^\//, ''));
const conn = { PGHOST: u.hostname, PGPORT: u.port || '5432', PGUSER: decodeURIComponent(u.username), PGPASSWORD: decodeURIComponent(u.password), PGDATABASE: db, ...(u.searchParams.get('sslmode') ? { PGSSLMODE: u.searchParams.get('sslmode') } : {}) };

const outIdx = process.argv.indexOf('--out');
const outDir = path.resolve(outIdx > -1 ? process.argv[outIdx + 1] : 'backups');
fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const file = path.join(outDir, `${db}-${stamp}.dump`);

console.log(`Backing up database "${db}" on ${u.hostname}:${conn.PGPORT} (read-only)...`);
const dump = run(bin('pg_dump'), ['--format=custom', '--no-owner', '--no-privileges', '--file', file], conn);
if (dump.status !== 0) { console.error('pg_dump failed:', (dump.stderr || dump.error || '').toString().split('\n')[0]); try { fs.unlinkSync(file); } catch { /* nothing written */ } process.exit(1); }

const size = fs.statSync(file).size;
if (size < 1024) { console.error(`The backup is suspiciously small (${size} bytes). Treat it as FAILED.`); process.exit(1); }
const list = run(bin('pg_restore'), ['--list', file], {});
if (list.status !== 0) { console.error('The backup file cannot be read back by pg_restore. Treat it as FAILED.'); process.exit(1); }
const toc = list.stdout;
const missing = ['TABLE public User ', 'TABLE public Transaction '].filter((t) => !toc.includes(t)); // pg_restore --list prints names unquoted
if (missing.length) { console.error(`The backup does not contain: ${missing.join(', ')}. Treat it as FAILED.`); process.exit(1); }
const tables = (toc.match(/ TABLE DATA public /g) || []).length;
const sha = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
fs.writeFileSync(`${file}.sha256`, `${sha}  ${path.basename(file)}\n`);

console.log(`OK  ${file}`);
console.log(`    ${(size / 1024).toFixed(0)} KiB, ${tables} tables with data in the dump, sha256 ${sha.slice(0, 16)}...`);
console.log('    Next: prove it restores:  node scripts/db-verify-restore.js ' + JSON.stringify(path.relative(process.cwd(), file)));
