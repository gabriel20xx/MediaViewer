FROM node:20-alpine

WORKDIR /app

# Install deps first for better caching
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src
COPY public ./public

RUN npm run build

ENV NODE_ENV=production

CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
