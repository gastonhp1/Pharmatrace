# Local Hardhat chain with the contracts already compiled. On start it boots
# `hardhat node` and deploys DrugTracker + CargoTracker (docker/chain-entrypoint.sh).
# The chain lives in memory: a restart gives a fresh chain, redeployed at the same
# addresses (same deployer, same nonces).
FROM node:22-slim

ENV NODE_ENV=development \
    HARDHAT_DISABLE_TELEMETRY_PROMPT=true \
    HOME=/tmp
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY hardhat.config.js ./
COPY contracts ./contracts
COPY scripts ./scripts
COPY docker/chain-entrypoint.sh /usr/local/bin/chain-entrypoint
RUN npx hardhat compile && chmod 0755 /usr/local/bin/chain-entrypoint

USER 10001:10001
EXPOSE 8545
ENTRYPOINT ["chain-entrypoint"]
