#!/usr/bin/env node
// Proves that a backup restores.   DATABASE_URL=<server+admin login> node scripts/db-verify-restore.js <file.dump> [--compare-to <source DATABASE_URL>]
//
//  1. creates a SCRATCH database named fintrack_verify_<timestamp> on the server in DATABASE_URL (it never touches any other database)
//  2. restores the dump into it
//  3. counts rows in every table; with --compare-to it also counts the same tables in the source and requires the numbers to match
//  4. ALWAYS drops the scratch database again (only a database whose name starts with fintrack_verify_ can ever be dropped by this script)
// Exit code 0 = the backup restored and (if compared) matches the source.
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const bin = (name) => (process.env.PG_BIN ? path.join(process.env.PG_BIN, process.platform === 'win32' ? `${name}.exe` : name) : name);
const run = (cmd, args, env) => spawnSync(cmd, args, { env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
const parse = (url) => { const u = new URL(url); return { host: u.hostname, env: { PGHOST: u.hostname, PGPORT: u.port || '5432', PGUSER: decodeURIComponent(u.username), PGPASSWORD: decodeURIComponent(u.password) }, db: decodeURIComponent(u.pathname.replace(/^\//, '')) }; };

const file = process.argv[2];
if (!file || !fs.existsSync(file)) { console.error('Usage: node scripts/db-verify-restore.js <backup.dump> [--compare-to <DATABASE_URL of the source>]'); process.exit(2); }
if (!process.env.DATABASE_URL) { console.error('Set DATABASE_URL to the server where the scratch database may be created.'); process.exit(2); }
const sidecar = `${file}.sha256`;
if (fs.existsSync(sidecar)) {
  const want = fs.readFileSync(sidecar, 'utf8').split(/\s+/)[0];
  const got = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (want !== got) { console.error('Checksum mismatch: the backup file changed or is corrupted.'); process.exit(1); }
  console.log('checksum OK');
}
const server = parse(process.env.DATABASE_URL);
const scratch = `fintrack_verify_${Date.now()}`;
const cmpIdx = process.argv.indexOf('--compare-to');
const source = cmpIdx > -1 ? parse(process.argv[cmpIdx + 1]) : null;

const counts = (conn, db) => {
  const tables = run(bin('psql'), ['-At', '-d', db, '-c', "select tablename from pg_tables where schemaname='public' and tablename <> '_prisma_migrations' order by 1"], conn).stdout.split(/\r?\n/).map((x) => x.trim()).filter(Boolean); // psql on Windows ends lines with CRLF
  const out = {};
  tables.forEach((t) => { out[t] = Number(run(bin('psql'), ['-At', '-d', db, '-c', `select count(*) from "${t}"`], conn).stdout.trim()); });
  return out;
};

let code = 0;
try {
  console.log(`creating scratch database ${scratch} ...`);
  let r = run(bin('createdb'), [scratch], server.env);
  if (r.status !== 0) { console.error('could not create the scratch database:', r.stderr.split('\n')[0]); process.exit(1); }
  r = run(bin('pg_restore'), ['--no-owner', '--no-privileges', '--exit-on-error', '-d', scratch, file], server.env);
  if (r.status !== 0) { console.error('RESTORE FAILED:', r.stderr.split('\n')[0]); code = 1; } else {
    const restored = counts(server.env, scratch);
    const total = Object.values(restored).reduce((a, b) => a + b, 0);
    console.log(`restored ${Object.keys(restored).length} tables, ${total} rows`);
    if (!Object.keys(restored).length || (total === 0 && !process.argv.includes('--allow-empty'))) { console.error('Nothing (or zero rows) was restored. Use --allow-empty only for a database that is meant to be empty.'); code = 1; }
    if (source) {
      const live = counts(source.env, source.db);
      const diff = Object.keys(live).filter((t) => live[t] !== restored[t]);
      if (diff.length) { console.error('Row counts differ from the source in: ' + diff.map((t) => `${t} (source ${live[t]}, restored ${restored[t]})`).join('; ')); code = 1; }
      else console.log(`row counts match the source for all ${Object.keys(live).length} tables`);
    }
  }
} finally {
  if (scratch.startsWith('fintrack_verify_')) {
    const d = run(bin('dropdb'), ['--if-exists', scratch], server.env);
    console.log(d.status === 0 ? 'scratch database dropped' : `WARNING: could not drop ${scratch}: ${d.stderr.split('\n')[0]}`);
  }
}
console.log(code === 0 ? 'VERIFIED: the backup restores.' : 'NOT VERIFIED.');
process.exit(code);
