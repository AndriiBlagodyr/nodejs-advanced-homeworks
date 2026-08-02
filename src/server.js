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
 * Attach raw HTTP request handling to a net/tls socket.
 */
export function attachRequestHandler(socket, { label = 'HTTP' } = {}) {
  socket.on('data', (buffer) => {
    const rawData = buffer.toString('utf-8');

    try {
      const req = parseHttpRequest(rawData);
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
