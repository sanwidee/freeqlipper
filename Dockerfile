FROM node:22-slim

# Install ffmpeg and python3 for whisper/yt-dlp support
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    curl \
    && rm -rf /var/lib/apt/lists/* \
    && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && pip3 install --break-system-packages bgutil-ytdlp-pot-provider

WORKDIR /app

# Copy backend
COPY backend/package*.json ./backend/
RUN cd backend && npm install --production

COPY backend/ ./backend/

# Copy built frontend
COPY frontend/dist/ ./frontend/dist/

WORKDIR /app/backend

EXPOSE 3001

CMD ["node", "server.js"]
