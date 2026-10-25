# Build stage
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json tsconfig*.json ./
RUN npm ci
COPY src/ ./src/
RUN npm run build

# Runtime stage
FROM node:22-alpine
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

# Run as `node` (uid 1000), not root, so files written to volumes are not root-owned.
# The supervisor needs to call docker, but that is granted by group, not by running as root. The group is not baked
# into the image (the gid of docker.sock differs between hosts): docker-compose.yml adds it at run time with
# `group_add: [DOCKER_GID]`, so one published image runs everywhere.
USER node

EXPOSE 3001
CMD ["node", "dist/index.js"]
