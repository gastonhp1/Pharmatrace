# Local Hardhat chain with the contracts already compiled. On start it boots
# `hardhat node` and deploys DrugTracker + CargoTracker (docker/chain-entrypoint.sh).
# The chain lives in memory: a restart gives a fresh chain, redeployed at the same
# addresses (same deployer, same nonces).
FROM node:22-slim

ENV NODE_ENV=development \
    HARDHAT_DISABLE_TELEMETRY_PROMPT=true \
    HOME=/tmp \
    PATH=/app/node_modules/.bin:$PATH
WORKDIR /app

# OS security updates on top of the base image.
RUN apt-get update && apt-get upgrade -y --no-install-recommends && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY hardhat.config.js ./
COPY contracts ./contracts
COPY scripts ./scripts
COPY docker/chain-entrypoint.sh /usr/local/bin/chain-entrypoint
# npm/npx/corepack are only needed to build; dropping them removes their bundled deps.
RUN hardhat compile && chmod 0755 /usr/local/bin/chain-entrypoint \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

USER 10001:10001
EXPOSE 8545
ENTRYPOINT ["chain-entrypoint"]
