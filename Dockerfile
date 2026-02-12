# =============================================================================
# Antigravity Manager - Docker Configuration
# =============================================================================
# This Dockerfile supports two modes:
# 1. Headless Mode (default): Runs only the NestJS proxy server
# 2. GUI Mode: Runs the full Electron app with X11 display (requires X forwarding)
#
# Note: OAuth authorization requires browser access on the host machine.
# See docker/README.md for detailed setup instructions.
# =============================================================================

# Build stage for compiling native modules and application
FROM node:22-bookworm AS builder

# Install build dependencies for native modules (better-sqlite3, keytar)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    libsecret-1-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files first for better layer caching
COPY package*.json ./

# Install all dependencies including devDependencies (needed for build)
RUN npm ci

# Copy source code
COPY . .

# Build the application
RUN npm run type-check

# =============================================================================
# Production stage - Headless proxy server mode
# =============================================================================
FROM node:22-bookworm-slim AS production

# Install runtime dependencies for native modules
RUN apt-get update && apt-get install -y --no-install-recommends \
    libsecret-1-0 \
    dumb-init \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user for security
RUN groupadd -r antigravity && useradd -r -g antigravity antigravity

WORKDIR /app

# Copy package files and install production dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application source (for NestJS server)
COPY --from=builder /app/src ./src
COPY --from=builder /app/tsconfig.json ./

# Create data directory with proper permissions
RUN mkdir -p /app/data && chown -R antigravity:antigravity /app

# Environment variables
ENV NODE_ENV=production
ENV ANTIGRAVITY_DATA_DIR=/app/data

# OAuth callback configuration
# When running in Docker, set this to a URL accessible from host browser
ENV OAUTH_REDIRECT_HOST=localhost
ENV OAUTH_REDIRECT_PORT=8888

# Proxy server configuration
ENV PROXY_PORT=8045
ENV PROXY_AUTO_START=true

# Volume for persistent data (database, config, keys)
VOLUME ["/app/data"]

# Expose ports
# 8045 - NestJS proxy server (OpenAI/Anthropic compatible API)
# 8888 - OAuth callback server
EXPOSE 8045 8888

# Switch to non-root user
USER antigravity

# Health check for the proxy server
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node -e "fetch('http://localhost:${PROXY_PORT:-8045}/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))" || exit 1

# Use dumb-init to properly handle signals
ENTRYPOINT ["/usr/bin/dumb-init", "--"]

# Start the application in headless mode
CMD ["node", "--experimental-specifier-resolution=node", "--loader", "ts-node/esm", "src/server/standalone.ts"]

# =============================================================================
# GUI stage - Full Electron application (optional, for development/testing)
# =============================================================================
FROM node:22-bookworm AS gui

# Install X11 and Electron dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Build dependencies
    python3 \
    make \
    g++ \
    # Electron runtime dependencies
    libgtk-3-0 \
    libnotify4 \
    libnss3 \
    libxss1 \
    libxtst6 \
    xdg-utils \
    libatspi2.0-0 \
    libdrm2 \
    libgbm1 \
    libasound2 \
    # Keytar dependencies
    libsecret-1-0 \
    libsecret-1-dev \
    gnome-keyring \
    # X11 dependencies
    xvfb \
    x11-xserver-utils \
    # Utilities
    dumb-init \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files and install all dependencies
COPY package*.json ./
RUN npm ci

# Copy application source
COPY . .

# Environment variables
ENV NODE_ENV=development
ENV DISPLAY=:99
ENV ELECTRON_DISABLE_GPU=true

# Create data directory
RUN mkdir -p /app/data

# Expose ports
EXPOSE 8045 8888

# Start with Xvfb for headless GUI rendering
CMD ["sh", "-c", "Xvfb :99 -screen 0 1024x768x24 & npm start"]
