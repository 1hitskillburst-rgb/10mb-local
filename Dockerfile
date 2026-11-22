# 10mb.video — Production Dockerfile
FROM node:20-alpine

# Install system ffmpeg for universal cross-platform compatibility
RUN apk add --no-cache ffmpeg

WORKDIR /app

# Copy package manifests first for efficient Docker layer caching
COPY package*.json ./

# Install production dependencies
RUN npm ci --omit=dev

# Copy application source files
COPY core/ ./core/
COPY server/ ./server/
COPY web/ ./web/
COPY cli/ ./cli/

# Create required persistent storage and scratch directories
RUN mkdir -p tmp storage/clips

# Expose HTTP port
EXPOSE 3000

ENV PORT=3000
ENV NODE_ENV=production

# Start Express compression server
CMD ["node", "server/index.js"]
