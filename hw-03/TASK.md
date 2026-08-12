# Homework — Raw HTTP/HTTPS server

## Brief

You build an HTTP server from scratch — without a framework and without the `http` module. The goal is to see that HTTP/1.1 is just text over TCP: you accept bytes from the socket yourself, parse the request-line and headers, and form a valid response yourself.

This is the level that `http.createServer` usually hides from you. At work, this is exactly what you need when you must figure out “why the client sees 400”, read `curl -v` or Wireshark output, and understand where `Content-Length`, `Connection: keep-alive`, and the status line come from.

## What to do

### 1. HTTP server on `net.createServer()`

No `require('http')` — you accept raw bytes from a TCP socket.

### 2. Request parser

Extract from the incoming text: `method`, `path`, and a `headers` map (keys normalized to lower-case).

### 3. Routing and valid responses

| Request | Response |
|---------|----------|
| `GET /` | `200 OK` (`Content-Type: text/plain`) |
| `GET /headers` | parsed request headers |
| anything else | `404 Not Found` |

Every response must be correct HTTP/1.1: status line, `Content-Type`, `Content-Length`, blank line, body.

### 4. HTTPS variant

On `tls.createServer()` (no `require('https')`), with a self-signed certificate (`openssl req -x509`). Reuse the same request handler.

### 5. Debug session

Paste into `README.md` the output of `openssl s_client -connect localhost:3443` including a `verify error` line (expected for self-signed) and explain in one sentence what that error code means:

| Code | Meaning |
|------|---------|
| 18 | self-signed |
| 19 | chain incomplete |
| 10 | expired |

**Constraints.** Start from an empty repository — all code is yours. The Node standard library (`net`, `tls`, `fs`, `crypto`) is allowed; third-party npm dependencies are not.

## Acceptance criteria

- [ ] **No `http`/`https`.** No file under `src/` imports `http` or `https`:
  `grep -REn "(require\(|from )['\"](node:)?https?['\"]" src/` produces no matches, while
  `grep -n "net.createServer" src/server.js` and
  `grep -n "tls.createServer" src/https-server.js` each produce one match.
- [ ] **Plain server responds correctly.**
  `curl -sv http://localhost:3000/` → first line `HTTP/1.1 200 OK` and header `Content-Type: text/plain`.
  `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/nope` prints `404`.
- [ ] **Header parser works.**
  `curl -s http://localhost:3000/headers -H "X-Demo: abc"` returns a body that includes lines `host:` and `x-demo: abc` (keys lower-case) — i.e. method/path/headers are actually parsed into a structure, not hardcoded.
- [ ] **HTTPS variant runs on a self-signed cert.**
  `curl -sk -o /dev/null -w "%{http_code}\n" https://localhost:3443/` prints `200`.
  The certificate generation command (`openssl req -x509 -newkey rsa:2048 -nodes ...`) is present in `README.md`, and `*.pem` / `*.key` are in `.gitignore` (not committed).
- [ ] **Debug session is documented.**
  `README.md` contains an `openssl s_client -connect localhost:3443 -servername localhost` output block with a line matching
  `grep -E "verify (error|return code)" README.md`,
  plus one sentence explaining the self-signed verify error code.

## Submission format

**Repository:** a public GitHub repository (or branch `hw-03` in an existing course repo) + a Pull Request.

**Structure:**

| File | Purpose |
|------|---------|
| `src/server.js` | raw HTTP on `net` |
| `src/https-server.js` | HTTPS on `tls` (reuses parser/handler from `server.js`) |
| `README.md` | start commands for both servers, self-signed cert generation command, pasted `openssl s_client` output with verify error explanation |
| `.gitignore` | excludes generated `*.pem` / `*.key` |

**README requirement:** the grader must be able to run everything with two commands (`node src/server.js`, `node src/https-server.js`) — no guessing ports or flags.

In the LMS, submit the **PR link**, not the main branch.

## Relation to the course project

This is a foundation homework outside the course project — it adds nothing to the Marketplace API.

Its goal is to build a mental model of HTTP/TLS at the bytes-and-sockets level. Later, when working with Express/Fastify (Lecture 4) and the NestJS layer, you will understand what the framework does for you, and you will be able to debug network and TLS issues with `curl -v` and `openssl s_client`, not only through framework logs.

Skills from this homework — reading a raw request, self-signed certificates, verify error codes — are reused directly in Lecture 27 (Security hardening, mTLS).
