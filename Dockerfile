FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY dashboard/package*.json ./dashboard/
RUN npm ci --prefix dashboard
COPY tsconfig.json ./
COPY src ./src
COPY dashboard ./dashboard
COPY public ./public
RUN npm run build

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist/src ./dist/src
COPY --from=build /app/public ./public
USER node
EXPOSE 3000
CMD ["node","dist/src/server.js"]
