import tls from 'node:tls';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachRequestHandler } from './server.js';

const PORT = 3443;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Certs live in hw-03/ (one level above src/)
const options = {
  key: fs.readFileSync(path.join(__dirname, '../cert.key')),
  cert: fs.readFileSync(path.join(__dirname, '../cert.pem')),
};

const server = tls.createServer(options, (socket) => {
  attachRequestHandler(socket, { label: 'HTTPS' });
});

server.listen(PORT, () => {
  console.log(`HTTPS Server is running on https://localhost:${PORT}`);
});
