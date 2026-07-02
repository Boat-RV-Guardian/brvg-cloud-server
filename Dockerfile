# Multi-stage: compile TS, then run a slim Node image with only prod deps.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# Persist the JSON db on a mounted volume, owned by the unprivileged node user.
RUN mkdir -p /app/data && chown -R node:node /app
VOLUME ["/app/data"]
ENV DB_PATH=/app/data/brvg.json
ENV PORT=3030
EXPOSE 3030
# Drop root: run as the built-in unprivileged `node` user.
USER node
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:3030/healthz || exit 1
CMD ["node", "dist/server.js"]
