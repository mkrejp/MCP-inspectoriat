FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY scripts ./scripts
COPY public ./public

ENV HOST=0.0.0.0 \
    DANGEROUSLY_BIND_ALL_INTERFACES=true \
    CLIENT_PORT=5173 \
    DASHBOARD_HOST=0.0.0.0 \
    DASHBOARD_PORT=4173 \
    MCP_AUTO_OPEN_ENABLED=false

EXPOSE 5173 4173

CMD ["npm", "start"]