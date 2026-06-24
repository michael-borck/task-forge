# Build a small production image for the Task Forge service.
FROM node:22-alpine

WORKDIR /app

# Install production deps first (better layer caching).
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# App source.
COPY server.js ./
COPY lib ./lib
COPY public ./public

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
