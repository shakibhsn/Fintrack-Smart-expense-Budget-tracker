const fs = require('fs');
const BASE = process.env.BASE || 'http://localhost:5055/api';
let pass = 0; let fail = 0;
const stamp = Date.now();

async function call(token, method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json, data: json.data };
}
async function register(tag) {
  const r = await call(null, 'POST', '/auth/register', { name: `User ${tag}`, email: `${tag}.${stamp}@test.dev`, password: 'secret123' });
  if (!r.data?.token) throw new Error('register failed ' + JSON.stringify(r.json));
  return r.data.token;
}
const tx = (t, type, amount, category, date, description = 'x') =>
  call(t, 'POST', '/transactions', { type, amount, category, description, date });
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> got ${JSON.stringify(actual)} expected ${JSON.stringify(expected)}`}`);
}
const done = () => { console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); };
// number of sidebar links = number of routes in the app (read from the route table so tests do not break when a page is added)
const navCount = () => (fs.readFileSync(require('path').join(__dirname, '../../src/core/routes.js'), 'utf8').match(/\{ path: '\//g) || []).length;
module.exports = { call, register, tx, eq, done, navCount };
