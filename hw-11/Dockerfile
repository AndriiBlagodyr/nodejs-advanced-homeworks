FROM node:22-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm test

FROM node:22-slim AS runner

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/.env.example ./.env.example

EXPOSE 3000

USER node

CMD ["node", "dist/main.js"]
