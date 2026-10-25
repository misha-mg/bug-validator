# For a server without a Claude login (docs/architecture.md, Deploy); the home server uses systemd.
FROM node:24-alpine

# The agent depends on this version's flags (--json-schema, --tools, structured_output).
RUN npm install -g @anthropic-ai/claude-code@2.1.303

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY agent ./agent
RUN mkdir -p /app/state && chown -R node:node /app

USER node
ENV NODE_ENV=production
CMD ["node", "src/main.ts", "run"]
