FROM node:20-bookworm-slim AS base

RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates ffmpeg \
	&& rm -rf /var/lib/apt/lists/*


FROM base AS deps

WORKDIR /app

COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi


FROM base AS build

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json* ./

COPY tsconfig.json ./
COPY src ./src
COPY public ./public

RUN npm run build


FROM base AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HTTPS_AUTO_SELF_SIGNED=1
ENV USE_SSL=false

# Keep only prod deps in runtime
COPY package.json package-lock.json* ./
# Copy node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules
RUN npm prune --omit=dev

COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/dist ./dist

# Writable dirs for runtime caches + auto-generated HTTPS certs
RUN mkdir -p /app/cache/thumbs /app/.mv-https \
	&& chown -R node:node /app/cache /app/.mv-https

EXPOSE 3000

USER node

CMD ["node", "dist/index.js"]
