# Production image of the marketplace API (HW-28).
#
# Build:  npm run image:build   (needs ./.npm_token, see README "Kubernetes")
#
# The registry token is a BuildKit secret: mounted as a file for the one RUN
# that needs it, never an ARG (that lands in the image history/config) and
# never COPY + rm (the bytes stay in the earlier layer under a whiteout).

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY docker/npmrc ./.npmrc
RUN --mount=type=secret,id=npm_token,required=true \
    --mount=type=cache,target=/root/.npm \
    NPM_TOKEN="$(cat /run/secrets/npm_token)" npm ci --ignore-scripts --no-audit --no-fund

FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npx tsc -p tsconfig.build.json

FROM node:22-bookworm-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY docker/npmrc ./.npmrc
RUN --mount=type=secret,id=npm_token,required=true \
    --mount=type=cache,target=/root/.npm \
    NPM_TOKEN="$(cat /run/secrets/npm_token)" npm ci --omit=dev --ignore-scripts --no-audit --no-fund

# No shell, no package manager: after an RCE there is no `sh` to run.
FROM gcr.io/distroless/nodejs22-debian12:nonroot
WORKDIR /app
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist/src ./dist/src
# Numeric: kubelet cannot resolve the name `nonroot` for runAsNonRoot.
USER 65532:65532
EXPOSE 3000
CMD ["dist/src/k8s/serve-main.js"]
