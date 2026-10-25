# Stage 1: Build web frontend
FROM node:22-alpine AS web-builder
WORKDIR /web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# Stage 2: Build cli backend
FROM node:22-alpine AS cli-builder
WORKDIR /cli
COPY cli/package*.json cli/tsconfig*.json ./
RUN apk add --no-cache python3 make g++ \
  && npm ci
COPY cli/src/ ./src/
RUN npm run build

# Stage 3: Runtime image
FROM node:22-alpine

WORKDIR /app

COPY cli/package*.json ./
# better-sqlite3 is a native module. Prebuilt binaries exist for linux-arm64
# (Raspberry Pi 4/5 on a 64-bit OS) and should be picked up automatically,
# but python3/make/g++ are kept here as a fallback so a missing prebuild
# falls back to compiling from source instead of failing the image build.
RUN apk add --no-cache python3 make g++ \
  && npm ci --omit=dev \
  && apk del python3 make g++

COPY --from=cli-builder /cli/dist/ ./dist/
COPY --from=web-builder /web/dist/ /app/web/dist/

# The data directory must exist and belong to `node` in the image: Docker seeds a new named volume
# (everythingapp_web_data in docker-compose.yml) with the ownership of the directory it is mounted over.
RUN mkdir -p /home/node/.everythingapp && chown -R node:node /home/node/.everythingapp

USER node

# The server binds to loopback by default; inside the container it has to accept connections from the Docker network.
# docker-compose.yml publishes the port on the host's 127.0.0.1 only.
ENV LISTEN_HOST=0.0.0.0
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/health || exit 1

CMD ["node", "dist/server.js"]
