# Match .nvmrc. The digest pins the multi-platform Node/Debian base image.
ARG NODE_IMAGE=docker.io/library/node:24.14.1-trixie-slim@sha256:9707cd4542f400df5078df04f9652a272429112f15202d22b5b8bdd148df494f

FROM ${NODE_IMAGE} AS dependencies
WORKDIR /app

# The existing HTTPS tests generate temporary certificates with OpenSSL.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund

FROM dependencies AS build
COPY index.html vite.config.js server.js ./
COPY public/ ./public/
COPY src/ ./src/
COPY server/ ./server/
COPY test/ ./test/
RUN npm test && npm prune --omit=dev --no-audit --no-fund

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DB_PATH=/data/todos.sqlite

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules/ ./node_modules/
COPY --from=build /app/dist/ ./dist/
COPY --from=build /app/server/ ./server/
# The SQLite store imports the shared model and location rules.
COPY --from=build /app/src/lib/ ./src/lib/
COPY --from=build /app/server.js ./

RUN mkdir /data && chown node:node /data
USER node
EXPOSE 3000
STOPSIGNAL SIGTERM
CMD ["node", "server.js"]
