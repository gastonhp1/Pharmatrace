# PharmaTrace REST API. Build from the repo root (it needs the ABIs in scripts/abi):
#   docker build -f backend/Dockerfile .
# All configuration comes from the environment (see backend/.env.example).
FROM node:22-slim

ENV NODE_ENV=production \
    PORT=3001 \
    IOT_DATA_DIR=/tmp/iot
WORKDIR /app/backend

COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY scripts/abi /app/scripts/abi
COPY backend ./

USER 10001:10001
EXPOSE 3001
CMD ["node", "server.js"]
