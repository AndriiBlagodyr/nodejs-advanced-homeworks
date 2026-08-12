/**
 * Split the raw HTTP request from the TCP socket into headers and body
 */
// Parameter sample:
// ''GET /headers HTTP/1.1\r\nHost: localhost:3000\r\nUser-Agent: curl/7.81.0\r\nAccept: */*\r\nX-Demo: abc\r\n\r\n'Hello, world!'

// Output:
// {
//   method: 'GET',
//   path: '/headers',
//   version: 'HTTP/1.1',
//   headers: {
//     host: 'localhost:3000',
//     'user-agent': 'curl/7.81.0',
//     accept: '*/*',
//     'x-demo': 'abc'
//   },
//   body: 'Hello, world!'
// }
export function parseHttpRequest(rawData) {
  // Split headers and body using double CRLF
  const [headersPart, ...bodyParts] = rawData.split('\r\n\r\n');
  const body = bodyParts.join('\r\n\r\n');

  const lines = headersPart.split('\r\n');
  const requestLine = lines.shift();

  if (!requestLine) {
    throw new Error('Empty request line');
  }

  // Parse the first line: METHOD PATH VERSION (e.g. GET /headers HTTP/1.1)
  const [method, path, version] = requestLine.split(' ');

  if (!method || !path || !version) {
    throw new Error('Invalid request line: expected METHOD PATH VERSION');
  }

  // Parse headers
  const headers = {};
  for (const line of lines) {
    if (!line.trim()) continue;

    const colonIndex = line.indexOf(':');
    if (colonIndex !== -1) {
      // Required by the homework: keys in lower-case!
      const key = line.slice(0, colonIndex).trim().toLowerCase();
      const value = line.slice(colonIndex + 1).trim();
      headers[key] = value;
    }
  }

  return { method, path, version, headers, body };
}

/**
 * Build a valid raw HTTP response format
 */
// buildHttpResponse(200, 'OK', {}, 'Hello')
// HTTP/1.1 200 OK\r\n
// Content-Type: text/plain\r\n
// Content-Length: 5\r\n
// Connection: close\r\n
// \r\n
// Hello
export function buildHttpResponse(statusCode, statusText, headers = {}, body = '') {
  const allHeaders = {
    'Content-Type': 'text/plain',
    'Content-Length': Buffer.byteLength(body),
    'Connection': 'close',
    ...headers,
  };

  const headersString = Object.entries(allHeaders)
    .map(([key, val]) => `${key}: ${val}`)
    .join('\r\n');

  return `HTTP/1.1 ${statusCode} ${statusText}\r\n${headersString}\r\n\r\n${body}`;
}