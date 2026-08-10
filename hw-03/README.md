# HW-03 — Raw HTTP/HTTPS server

Assignment: [`TASK.md`](./TASK.md).

## Run

From this folder (`hw-03/`):

HTTP on port **3000**, HTTPS on port **3443**:

```bash
cd hw-03
node src/server.js
node src/https-server.js
```

## Self-signed certificate

Generate inside `hw-03/` (next to `src/`):

```bash
cd hw-03
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout cert.key -out cert.pem -days 365 \
  -subj "/CN=localhost"
```

## Debug session — `openssl s_client`

```bash
openssl s_client -connect localhost:3443 -servername localhost
```

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

`verify error:num=18` means the peer certificate is self-signed: OpenSSL has no trusted CA that signed it, which is expected for a local development certificate.
