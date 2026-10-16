# PharmaTrace REST API. Build from the repo root (it needs the ABIs in scripts/abi):
#   docker build -f backend/Dockerfile .
# All configuration comes from the environment (see backend/.env.example).
FROM node:22-slim

ENV NODE_ENV=production \
    PORT=3001 \
    IOT_DATA_DIR=/tmp/iot
WORKDIR /app/backend

# OS security updates on top of the base image.
RUN apt-get update && apt-get upgrade -y --no-install-recommends && rm -rf /var/lib/apt/lists/*

COPY backend/package.json backend/package-lock.json ./
# npm/npx/corepack are only needed to install; dropping them removes their bundled deps.
RUN npm ci --omit=dev --no-audit --no-fund \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

COPY scripts/abi /app/scripts/abi
COPY backend ./

USER 10001:10001
EXPOSE 3001
CMD ["node", "server.js"]
