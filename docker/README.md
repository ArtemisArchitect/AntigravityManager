# Docker Deployment Guide for Antigravity Manager

This guide explains how to run Antigravity Manager in a Docker container, including handling OAuth authorization which requires browser interaction.

## Table of Contents

- [Overview](#overview)
- [Quick Start](#quick-start)
- [OAuth Authorization Flow](#oauth-authorization-flow)
- [Configuration](#configuration)
- [Architecture](#architecture)
- [Troubleshooting](#troubleshooting)

## Overview

Antigravity Manager is an Electron desktop application that manages Google Cloud accounts for AI services. When running in Docker, we provide a **headless mode** that runs only the NestJS proxy server, suitable for server deployments.

### Key Components

| Component | Description | Port |
|-----------|-------------|------|
| **Proxy Server** | OpenAI/Anthropic compatible API proxy | 8045 |
| **OAuth Server** | Handles Google OAuth callbacks | 8888 |

### Deployment Modes

1. **Headless Mode (Production)**: Runs only the proxy server, no GUI
2. **GUI Mode (Development)**: Full Electron app with X11 display support

## Quick Start

### 1. Build and Run

```bash
# Clone the repository
git clone https://github.com/Draculabo/AntigravityManager.git
cd AntigravityManager

# Build and start the container
docker-compose up -d

# View logs
docker-compose logs -f
```

### 2. Authorize with Google

After starting the container, you need to authorize at least one Google account:

1. Open your browser and go to: `http://localhost:8888/auth/start`
2. Click "Authorize with Google"
3. Complete the OAuth flow in your browser
4. The token will be automatically captured and stored

### 3. Use the API

Once authorized, you can use the proxy API:

```bash
# Example: List models (OpenAI compatible)
curl http://localhost:8045/v1/models \
  -H "Authorization: Bearer YOUR_API_KEY"

# Example: Chat completion
curl http://localhost:8045/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "model": "gemini-2.0-flash",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

## OAuth Authorization Flow

Since OAuth requires browser interaction, here's how it works with Docker:

```
┌─────────────────────────────────────────────────────────────────────┐
│                         HOST MACHINE                                 │
│                                                                      │
│  ┌─────────────┐        ┌──────────────────────────────────────┐   │
│  │   Browser   │        │         Docker Container              │   │
│  │             │        │                                        │   │
│  │  1. Visit   │───────▶│  localhost:8888/auth/start            │   │
│  │  auth/start │        │         (OAuth Server)                 │   │
│  │             │        │                                        │   │
│  │  2. Redirect│───────▶│  Google OAuth Consent                 │   │
│  │  to Google  │        │         (External)                     │   │
│  │             │        │                                        │   │
│  │  3. Callback│◀───────│  localhost:8888/oauth-callback        │   │
│  │  with code  │        │         (OAuth Server)                 │   │
│  │             │        │                                        │   │
│  │  4. Success │◀───────│  Token stored in database             │   │
│  │  page shown │        │                                        │   │
│  └─────────────┘        │                                        │   │
│                         │  ┌────────────────────────────────┐   │   │
│  API Clients   ─────────┼─▶│  localhost:8045 (Proxy Server) │   │   │
│  (curl, apps)           │  └────────────────────────────────┘   │   │
│                         └──────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

### Important Notes

1. **Port 8888 must be accessible** from your host browser for OAuth callbacks
2. **The redirect URI** (`http://localhost:8888/oauth-callback`) must match the Google Cloud Console configuration
3. For **remote deployments**, you may need to configure a proper hostname:

```bash
# Set custom OAuth redirect host
OAUTH_REDIRECT_HOST=your-server.example.com docker-compose up -d
```

## Configuration

### Environment Variables

Create a `.env` file in the project root:

```env
# Proxy server configuration
PROXY_PORT=8045
PROXY_API_KEY=your-secure-api-key
PROXY_REQUEST_TIMEOUT=120

# OAuth configuration
OAUTH_REDIRECT_HOST=localhost
OAUTH_REDIRECT_PORT=8888

# Upstream proxy (optional)
UPSTREAM_PROXY_ENABLED=false
UPSTREAM_PROXY_URL=http://proxy.example.com:8080

# Logging
LOG_LEVEL=info
```

### Volume Mounts

Data is persisted in a Docker volume:

```yaml
volumes:
  - antigravity-data:/app/data
```

The volume contains:
- `cloud_accounts.db` - Account database
- `.mk` - Encryption key file (fallback)
- Configuration files

### Custom Configuration

```bash
# Start with custom environment
docker-compose up -d \
  -e PROXY_PORT=9000 \
  -e PROXY_API_KEY=my-secret-key
```

## Architecture

### Headless Mode Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Docker Container                          │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐  │
│  │               standalone.ts                           │  │
│  │  (Entry Point)                                        │  │
│  └───────────────────┬──────────────────────────────────┘  │
│                      │                                       │
│         ┌────────────┴────────────┐                         │
│         │                         │                         │
│  ┌──────▼──────┐          ┌──────▼──────┐                  │
│  │ OAuth Server│          │ NestJS Proxy│                  │
│  │   (8888)    │          │   (8045)    │                  │
│  └─────────────┘          └──────┬──────┘                  │
│                                  │                          │
│                    ┌─────────────┼─────────────┐           │
│                    │             │             │           │
│              ┌─────▼─────┐ ┌─────▼─────┐ ┌────▼────┐      │
│              │  Token    │ │  Proxy    │ │ Gemini  │      │
│              │  Manager  │ │  Service  │ │ Client  │      │
│              └───────────┘ └───────────┘ └─────────┘      │
│                    │                                       │
│              ┌─────▼─────┐                                 │
│              │ SQLite DB │                                 │
│              │ (better-  │                                 │
│              │  sqlite3) │                                 │
│              └───────────┘                                 │
│                                                            │
│  Volume: /app/data                                         │
└────────────────────────────────────────────────────────────┘
```

### Security Considerations

1. **Encryption Keys**: In Docker, the encryption key is stored in a file (`.mk`) since system keychains (keytar) may not be available
2. **API Key**: Always set a strong `PROXY_API_KEY` in production
3. **Network**: Use proper network isolation and firewall rules
4. **Secrets**: Never commit `.env` files with real credentials

## Troubleshooting

### OAuth Callback Not Working

**Symptom**: Browser shows "Connection refused" after Google authorization

**Solutions**:
1. Ensure port 8888 is exposed: `docker-compose ps`
2. Check container logs: `docker-compose logs oauth-server`
3. Verify firewall allows connections to port 8888

### Database Errors

**Symptom**: "Database is locked" or SQLite errors

**Solutions**:
1. Ensure the volume has proper permissions
2. Check disk space: `docker exec antigravity-proxy df -h /app/data`
3. Restart the container: `docker-compose restart`

### Native Module Errors

**Symptom**: "Cannot find module 'better-sqlite3'" or similar

**Solutions**:
1. Rebuild the container: `docker-compose build --no-cache`
2. Check the build logs for compilation errors
3. Ensure the base image is correct (node:22-bookworm)

### Container Health Check Failing

**Symptom**: Container status shows "unhealthy"

**Solutions**:
1. Check if the proxy is starting: `docker-compose logs`
2. Verify port 8045 is not in use by another process
3. Check the health endpoint manually:
   ```bash
   docker exec antigravity-proxy curl -f http://localhost:8045/health
   ```

## Advanced Usage

### Running Multiple Instances

```yaml
# docker-compose.override.yml
services:
  antigravity-proxy-2:
    extends:
      service: antigravity-proxy
    container_name: antigravity-proxy-2
    ports:
      - "8046:8045"
      - "8889:8888"
    volumes:
      - antigravity-data-2:/app/data

volumes:
  antigravity-data-2:
```

### Integration with Reverse Proxy

```nginx
# nginx.conf example
upstream antigravity {
    server localhost:8045;
}

server {
    listen 443 ssl;
    server_name api.example.com;

    location / {
        proxy_pass http://antigravity;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

### CI/CD Integration

```yaml
# .github/workflows/docker-publish.yml
name: Docker Build

on:
  push:
    tags: ['v*']

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: docker/build-push-action@v5
        with:
          context: .
          push: true
          tags: ghcr.io/${{ github.repository }}:${{ github.ref_name }}
```

## License

This Docker configuration is part of Antigravity Manager, licensed under CC BY-NC-SA 4.0.

For educational purposes only. Commercial use is prohibited.
