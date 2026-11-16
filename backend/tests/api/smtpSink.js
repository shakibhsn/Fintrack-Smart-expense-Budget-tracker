// A tiny SMTP server for tests: accepts any message (AUTH PLAIN/LOGIN included) and records it. No mail ever leaves the machine.
const net = require('net');

function startSink(port = 2525) {
  const messages = [];
  const sockets = new Set();
  const server = net.createServer((sock) => {
    sockets.add(sock); sock.on('close', () => sockets.delete(sock));
    sock.setEncoding('utf8');
    let buf = ''; let inData = false; let data = ''; let cur = { from: null, to: [], auth: null };
    const say = (l) => sock.write(l + '\r\n');
    say('220 sink ESMTP');
    sock.on('data', (chunk) => {
      buf += chunk;
      for (;;) {
        if (inData) {
          data += buf; buf = '';
          const end = data.indexOf('\r\n.\r\n');
          if (end === -1) break; // the terminator may be split across TCP chunks: keep accumulating
          buf = data.slice(end + 5); const body = data.slice(0, end); data = '';
          messages.push({ ...cur, raw: body }); inData = false; cur = { from: null, to: [], auth: cur.auth };
          say('250 queued'); continue;
        }
        const nl = buf.indexOf('\r\n');
        if (nl === -1) break;
        const line = buf.slice(0, nl); buf = buf.slice(nl + 2);
        const up = line.toUpperCase();
        if (up.startsWith('EHLO') || up.startsWith('HELO')) { sock.write('250-sink\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n'); }
        else if (up.startsWith('AUTH PLAIN')) { const b = Buffer.from(line.split(' ')[2] || '', 'base64').toString('utf8').split('\u0000'); cur.auth = { user: b[1], pass: b[2] }; say('235 ok'); }
        else if (up.startsWith('AUTH LOGIN')) { cur.auth = { user: '', pass: '' }; say('235 ok'); }
        else if (up.startsWith('MAIL FROM')) { cur.from = line.slice(10); say('250 ok'); }
        else if (up.startsWith('RCPT TO')) { cur.to.push(line.slice(8)); say('250 ok'); }
        else if (up === 'DATA') { inData = true; say('354 go'); }
        else if (up === 'QUIT') { say('221 bye'); sock.end(); }
        else say('250 ok');
      }
    });
    sock.on('error', () => {});
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({
    messages, port,
    close: () => new Promise((r) => { sockets.forEach((s) => s.destroy()); server.close(() => r()); }),
  })));
}
const decode = (raw) => raw.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
module.exports = { startSink, decode };
