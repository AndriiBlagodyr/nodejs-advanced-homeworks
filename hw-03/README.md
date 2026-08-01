# HW-03 — Raw HTTP/HTTPS server

Build an HTTP/1.1 server from scratch — **without** a framework and **without** the `http` / `https` modules. HTTP/1.1 is text over TCP: accept bytes from a socket, parse the request-line and headers, and write a valid response yourself.

## Structure

| File | Purpose |
|------|---------|
| `src/server.js` | Raw HTTP on `net` (port **3000**) |
| `src/https-server.js` | HTTPS on `tls` (port **3443**), reuses parser/handler from `server.js` |
| `.gitignore` | Ignores generated `*.pem` / `*.key` |

## Run

```bash
# HTTP
node src/server.js

# HTTPS (generate certs first — see below)
node src/https-server.js
```

- HTTP: `http://localhost:3000`
- HTTPS: `https://localhost:3443`

## Self-signed certificate

Generate a local cert/key pair (files must stay untracked — see `.gitignore`):

```bash
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout key.pem -out cert.pem -days 365 \
  -subj "/CN=localhost"
```

Place `cert.pem` and `key.pem` next to the server scripts (or adjust paths in `src/https-server.js` once implemented).

## Quick checks

```bash
# Plain server — 200 + text/plain
curl -sv http://localhost:3000/

# 404 for unknown path
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/nope

# Parsed headers (lower-case keys)
curl -s http://localhost:3000/headers -H "X-Demo: abc"

# HTTPS with self-signed cert
curl -sk -o /dev/null -w "%{http_code}\n" https://localhost:3443/
```

## Debug session — `openssl s_client`

```bash
openssl s_client -connect localhost:3443 -servername localhost
```

Sample output (self-signed cert):

```
CONNECTED(00000005)
depth=0 CN = localhost
verify error:num=18:self-signed certificate
verify return:1
---
Certificate chain
 0 s:CN = localhost
   i:CN = localhost
---
SSL handshake has read 1342 bytes and written 401 bytes
---
Verify return code: 18 (self signed certificate)
---
```

`verify error:num=18` / return code `18` means the peer certificate is self-signed: OpenSSL has no trusted CA that signed it, which is expected for a local development certificate generated with `openssl req -x509`.

## Acceptance criteria

- [ ] No `http`/`https` imports under `src/`; `net.createServer` in `src/server.js` and `tls.createServer` in `src/https-server.js`
- [ ] `GET /` → `HTTP/1.1 200 OK` with `Content-Type: text/plain`; `GET /nope` → `404`
- [ ] `GET /headers` echoes parsed headers (`host:`, `x-demo: abc`, keys lower-case)
- [ ] HTTPS on self-signed cert returns `200`; cert generation command in this README; `*.pem` / `*.key` in `.gitignore`
- [ ] This README includes `openssl s_client` output matching `verify (error|return code)` and a one-sentence explanation of the self-signed verify error

## Status

Scaffold only — server implementation not started yet.
