# The image's bundled Chromium must be the one the locked `playwright` package expects: keep this tag equal to the
# playwright version in package-lock.json (src/__tests__/dockerfile.test.ts checks it). Global ARG: before the first FROM.
ARG PLAYWRIGHT_IMAGE_TAG=v1.63.0-noble

FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json tsconfig*.json ./
RUN npm ci
COPY src/ ./src/
RUN npm run build

FROM mcr.microsoft.com/playwright:${PLAYWRIGHT_IMAGE_TAG}

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

# The browsers come with the base image; nothing is downloaded at install or run time.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# No docker.sock. The container sits on its own network (browser-egress in docker-compose.yml) and shares none with the
# sandboxes or the other services; deploy/egress-guard.sh keeps it off private ranges.
USER pwuser

EXPOSE 3003
CMD ["node", "dist/index.js"]
