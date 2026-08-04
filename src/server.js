import net from 'node:net';
import { pathToFileURL } from 'node:url';
import { parseHttpRequest, buildHttpResponse } from './parser.js';

const PORT = 3000;

/**
 * Route a parsed request to an HTTP/1.1 response string.
 */
export function handleRequest(req) {
  if (req.path === '/' && req.method === 'GET') {
    return buildHttpResponse(
      200,
      'OK',
      { 'Content-Type': 'text/plain' },
      'Hello from raw HTTP server!'
    );
  }

  if (req.path === '/headers' && req.method === 'GET') {
    const body = Object.entries(req.headers)
      .map(([key, value]) => `${key}: ${value}`)
      .join('\n');

    return buildHttpResponse(
      200,
      'OK',
      { 'Content-Type': 'text/plain' },
      body
    );
  }

  return buildHttpResponse(
    404,
    'Not Found',
    { 'Content-Type': 'text/plain' },
    '404 Not Found'
  );
}

/**
 * Read Content-Length from a raw header block (before \r\n\r\n).
 * Returns 0 when the header is missing or invalid.
 */
function getContentLength(headersPart) {
  const lines = headersPart.split('\r\n').slice(1); // skip request-line
  for (const line of lines) {
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;

    const key = line.slice(0, colonIndex).trim().toLowerCase();
    if (key !== 'content-length') continue;

    const n = Number(line.slice(colonIndex + 1).trim());
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }
  return 0;
}

/**
 * Attach raw HTTP request handling to a net/tls socket.
 * 1) Buffer until headers end (\r\n\r\n)
 * 2) Buffer until body length from Content-Length is present
 * Framing uses latin1 so 1 byte = 1 character (safe indices / lengths).
 */
export function attachRequestHandler(socket, { label = 'HTTP' } = {}) {
  let buf = '';
  let done = false;

  socket.on('data', (chunk) => {
    if (done) return;

    // latin1: 1 byte ↔ 1 char — framing indices stay correct
    buf += chunk.toString('latin1');

    const headerEnd = buf.indexOf('\r\n\r\n');
    if (headerEnd === -1) return; // still waiting for headers

    const contentLength = getContentLength(buf.slice(0, headerEnd));
    const totalNeeded = headerEnd + 4 + contentLength; // 4 = length of \r\n\r\n
    if (buf.length < totalNeeded) return; // still waiting for body bytes

    done = true;
    const rawRequest = buf.slice(0, totalNeeded);

    try {
      const req = parseHttpRequest(rawRequest);
      console.log(`[${label}] [${new Date().toISOString()}] ${req.method} ${req.path}`);

      const response = handleRequest(req);
      socket.write(response);
      socket.end();
    } catch (err) {
      console.error('Error parsing request:', err.message);
      const errorResponse = buildHttpResponse(
        400,
        'Bad Request',
        { 'Content-Type': 'text/plain' },
        'Bad Request'
      );
      socket.write(errorResponse);
      socket.end();
    }
  });

  socket.on('error', (err) => {
    if (err.code !== 'ECONNRESET') {
      console.error('Socket error:', err);
    }
  });
}

const server = net.createServer((socket) => {
  attachRequestHandler(socket, { label: 'HTTP' });
});

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  server.listen(PORT, () => {
    console.log(`HTTP Server is running on http://localhost:${PORT}`);
  });
}
