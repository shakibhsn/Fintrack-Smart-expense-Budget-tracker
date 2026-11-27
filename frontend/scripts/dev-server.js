const fs = require('fs');
const http = require('http');
const path = require('path');

const root = path.resolve(__dirname, '..');
const port = Number(process.env.FRONTEND_PORT) || 5500;
const apiPort = Number(process.env.API_PORT) || 5000;
const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }

  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
    const headers = { ...req.headers, host: `localhost:${apiPort}` };
    if (!headers['x-forwarded-for']) headers['x-forwarded-for'] = req.socket.remoteAddress || '';
    const upstream = http.request({
      hostname: '127.0.0.1',
      port: apiPort,
      method: req.method,
      path: `${url.pathname}${url.search}`,
      headers,
    }, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    });

    upstream.on('error', (error) => {
      console.error(`[proxy] ${error.message}`);
      if (res.headersSent) {
        res.destroy(error);
        return;
      }
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, message: 'FinTrack API is unavailable' }));
    });
    req.pipe(upstream);
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end();
    return;
  }
  if (url.pathname.split('/').some((part) => part.startsWith('.'))) {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }

  let file;
  try {
    file = path.resolve(root, `.${decodeURIComponent(url.pathname)}`);
  } catch {
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }
  if (file !== root && !file.startsWith(`${root}${path.sep}`)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(file, (statError, stat) => {
    if (statError) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    if (stat.isDirectory()) file = path.join(file, 'index.html');

    res.setHeader('Content-Type', mimeTypes[path.extname(file)] || 'application/octet-stream');
    if (req.method === 'HEAD') {
      res.writeHead(200);
      res.end();
      return;
    }

    const stream = fs.createReadStream(file);
    stream.on('error', (error) => {
      console.error(`[static] ${error.message}`);
      if (!res.headersSent) res.writeHead(404);
      res.end();
    });
    stream.pipe(res);
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`FinTrack frontend and API proxy running at http://localhost:${port}`);
});
