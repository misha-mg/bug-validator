# Not the deployment (that is systemd: docs/architecture.md, Deploy); kept building, untested in use.
FROM node:24-alpine

# The version the systemd deployment runs; the agent depends on its flags (--json-schema, --tools,
# --max-budget-usd, structured_output).
RUN npm install -g @anthropic-ai/claude-code@2.1.312

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY agent ./agent
RUN mkdir -p /app/state && chown -R node:node /app

USER node
ENV NODE_ENV=production TZ=Europe/Warsaw DISABLE_AUTOUPDATER=1
CMD ["node", "src/main.ts", "run"]
