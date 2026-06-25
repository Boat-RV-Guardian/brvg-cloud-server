# Multi-stage: compile TS, then run a slim Node image with only prod deps.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
# Persist the JSON db on a mounted volume.
VOLUME ["/app/data"]
ENV DB_PATH=/app/data/brvg.json
ENV PORT=3030
EXPOSE 3030
CMD ["node", "dist/server.js"]
