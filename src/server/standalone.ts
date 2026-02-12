/**
 * Standalone NestJS Proxy Server Entry Point
 *
 * This file allows the proxy server to run independently without Electron,
 * making it suitable for Docker containerization and headless deployment.
 *
 * Usage:
 *   NODE_ENV=production node --loader ts-node/esm src/server/standalone.ts
 *
 * Environment Variables:
 *   - PROXY_PORT: Port for the proxy server (default: 8045)
 *   - PROXY_API_KEY: API key for authentication
 *   - PROXY_REQUEST_TIMEOUT: Request timeout in seconds (default: 120)
 *   - OAUTH_REDIRECT_HOST: Host for OAuth callback (default: localhost)
 *   - OAUTH_REDIRECT_PORT: Port for OAuth callback (default: 8888)
 *   - ANTIGRAVITY_DATA_DIR: Custom data directory (default: ~/.antigravity-agent)
 *   - LOG_LEVEL: Logging level (default: info)
 */

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import http from 'http';
import fs from 'fs';

// Set up custom data directory before importing modules that use it
const customDataDir = process.env.ANTIGRAVITY_DATA_DIR;
if (customDataDir) {
  // Ensure the directory exists
  if (!fs.existsSync(customDataDir)) {
    fs.mkdirSync(customDataDir, { recursive: true });
  }
  console.log(`[Standalone] Using custom data directory: ${customDataDir}`);
}

import { AppModule } from './app.module';
import { setServerConfig } from './server-config';
import type { ProxyConfig } from '../types/config';

// Console logger for standalone mode (winston may not be available without Electron)
const logger = {
  info: (message: string, ...args: unknown[]) => console.log(`[INFO] ${message}`, ...args),
  warn: (message: string, ...args: unknown[]) => console.warn(`[WARN] ${message}`, ...args),
  error: (message: string, ...args: unknown[]) => console.error(`[ERROR] ${message}`, ...args),
};

/**
 * Get configuration from environment variables
 */
function getConfigFromEnv(): ProxyConfig {
  return {
    enabled: true,
    port: parseInt(process.env.PROXY_PORT || '8045', 10),
    api_key: process.env.PROXY_API_KEY || '',
    auto_start: true,
    backend_canary_enabled: process.env.BACKEND_CANARY_ENABLED !== 'false',
    custom_mapping: {},
    anthropic_mapping: {},
    request_timeout: parseInt(process.env.PROXY_REQUEST_TIMEOUT || '120', 10),
    upstream_proxy: {
      enabled: process.env.UPSTREAM_PROXY_ENABLED === 'true',
      url: process.env.UPSTREAM_PROXY_URL || '',
    },
  };
}

/**
 * OAuth Callback Server for handling Google authorization
 * When running in Docker, users need to:
 * 1. Access the auth URL from their host browser
 * 2. Complete OAuth in the browser
 * 3. The callback redirects to this server which captures the code
 */
class StandaloneAuthServer {
  private server: http.Server | null = null;
  private readonly host: string;
  private readonly port: number;

  constructor() {
    this.host = process.env.OAUTH_REDIRECT_HOST || 'localhost';
    this.port = parseInt(process.env.OAUTH_REDIRECT_PORT || '8888', 10);
  }

  start(): void {
    if (this.server) {
      logger.warn('AuthServer: Server already running');
      return;
    }

    this.server = http.createServer((req, res) => {
      const url = new URL(req.url || '', `http://${this.host}:${this.port}`);

      // Health check endpoint
      if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', service: 'oauth-callback' }));
        return;
      }

      // Auth start endpoint - provides the OAuth URL
      if (url.pathname === '/auth/start') {
        const authUrl = this.getGoogleAuthUrl();
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
          <!DOCTYPE html>
          <html>
            <head>
              <title>Antigravity Manager - OAuth Setup</title>
              <style>
                body { font-family: system-ui, -apple-system, sans-serif; max-width: 800px; margin: 50px auto; padding: 20px; }
                h1 { color: #333; }
                .auth-link { display: inline-block; padding: 12px 24px; background: #4285f4; color: white; text-decoration: none; border-radius: 6px; margin: 20px 0; }
                .auth-link:hover { background: #357abd; }
                pre { background: #f5f5f5; padding: 15px; border-radius: 6px; overflow-x: auto; }
                .note { background: #fff3cd; padding: 15px; border-radius: 6px; margin: 20px 0; }
              </style>
            </head>
            <body>
              <h1>🔐 Google OAuth Authorization</h1>
              <p>Click the button below to authorize Antigravity Manager with your Google account:</p>
              <a href="${authUrl}" class="auth-link">Authorize with Google</a>
              
              <div class="note">
                <strong>Note:</strong> After authorization, you will be redirected back to this server.
                The OAuth token will be captured and stored automatically.
              </div>
              
              <h2>Manual Authorization</h2>
              <p>If the button doesn't work, copy this URL and open it in your browser:</p>
              <pre>${authUrl}</pre>
            </body>
          </html>
        `);
        return;
      }

      // OAuth callback endpoint
      if (url.pathname === '/oauth-callback') {
        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');

        if (code) {
          logger.info(`AuthServer: Received authorization code: ${code.substring(0, 10)}...`);

          // In standalone mode, we need to exchange the code for tokens
          this.handleAuthCode(code)
            .then((result) => {
              res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
              res.end(`
                <!DOCTYPE html>
                <html>
                  <head>
                    <title>Authorization Successful</title>
                    <style>
                      body { font-family: system-ui, -apple-system, sans-serif; text-align: center; padding-top: 50px; }
                      .success { color: #28a745; }
                      .error { color: #dc3545; }
                    </style>
                  </head>
                  <body>
                    <h1 class="success">✅ Authorization Successful</h1>
                    <p>Account: <strong>${result.email}</strong></p>
                    <p>You can close this window and start using the API.</p>
                  </body>
                </html>
              `);
            })
            .catch((err) => {
              logger.error('AuthServer: Failed to exchange code:', err);
              res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
              res.end(`
                <html>
                  <body style="font-family: sans-serif; text-align: center; padding-top: 50px;">
                    <h1 style="color: #dc3545;">❌ Authorization Failed</h1>
                    <p>Error: ${err instanceof Error ? err.message : String(err)}</p>
                    <p><a href="/auth/start">Try Again</a></p>
                  </body>
                </html>
              `);
            });
        } else if (error) {
          logger.error(`AuthServer: OAuth error: ${error}`);
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`
            <html>
              <body>
                <h1>Login Failed</h1>
                <p>Error: ${error}</p>
              </body>
            </html>
          `);
        } else {
          res.writeHead(400);
          res.end('Missing code parameter');
        }
        return;
      }

      // Default response
      res.writeHead(404);
      res.end('Not Found');
    });

    this.server.on('error', (err) => {
      logger.error('AuthServer: Server error', err);
    });

    this.server.listen(this.port, '0.0.0.0', () => {
      logger.info(`AuthServer: Listening on http://0.0.0.0:${this.port}`);
      logger.info(
        `AuthServer: OAuth setup page available at http://${this.host}:${this.port}/auth/start`,
      );
    });
  }

  private getGoogleAuthUrl(): string {
    const CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
    const redirectUri = `http://${this.host}:${this.port}/oauth-callback`;

    const scopes = [
      'https://www.googleapis.com/auth/cloud-platform',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/cclog',
      'https://www.googleapis.com/auth/experimentsandconfigs',
    ].join(' ');

    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: scopes,
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
    });

    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  private async handleAuthCode(code: string): Promise<{ email: string }> {
    const CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
    const CLIENT_SECRET = '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';
    const redirectUri = `http://${this.host}:${this.port}/oauth-callback`;

    // Exchange code for tokens
    const tokenParams = new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code: code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    });

    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenParams,
    });

    if (!tokenResponse.ok) {
      const text = await tokenResponse.text();
      throw new Error(`Token exchange failed: ${text}`);
    }

    const tokens = (await tokenResponse.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      token_type: string;
    };

    // Get user info
    const userResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });

    if (!userResponse.ok) {
      throw new Error('Failed to fetch user info');
    }

    const userInfo = (await userResponse.json()) as {
      email: string;
      name?: string;
      picture?: string;
    };

    // Store the account (simplified storage for standalone mode)
    await this.storeAccount(userInfo, tokens);

    return { email: userInfo.email };
  }

  private async storeAccount(
    userInfo: { email: string; name?: string; picture?: string },
    tokens: {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      token_type: string;
    },
  ): Promise<void> {
    // Dynamically import CloudAccountRepo to add the account
    try {
      const { CloudAccountRepo } = await import('../ipc/database/cloudHandler');
      const { v4: uuidv4 } = await import('uuid');
      await CloudAccountRepo.init();

      const nowMs = Date.now();
      const nowSeconds = Math.floor(nowMs / 1000);
      await CloudAccountRepo.addAccount({
        id: uuidv4(),
        provider: 'google',
        email: userInfo.email,
        name: userInfo.name,
        avatar_url: userInfo.picture,
        token: {
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token || '',
          token_type: tokens.token_type,
          expires_in: tokens.expires_in,
          expiry_timestamp: nowSeconds + tokens.expires_in,
        },
        created_at: nowMs,
        last_used: nowMs,
      });

      logger.info(`AuthServer: Account ${userInfo.email} stored successfully`);
    } catch (error) {
      logger.error('AuthServer: Failed to store account:', error);
      throw error;
    }
  }

  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
      logger.info('AuthServer: Stopped');
    }
  }
}

/**
 * Bootstrap the standalone proxy server
 */
async function bootstrap(): Promise<void> {
  logger.info('=========================================');
  logger.info('Antigravity Manager - Standalone Proxy');
  logger.info('=========================================');

  const config = getConfigFromEnv();
  const port = config.port;

  logger.info(`Configuration:`);
  logger.info(`  - Proxy Port: ${port}`);
  logger.info(`  - Request Timeout: ${config.request_timeout}s`);
  logger.info(
    `  - Upstream Proxy: ${config.upstream_proxy.enabled ? config.upstream_proxy.url : 'disabled'}`,
  );

  // Set server config for the NestJS modules
  setServerConfig(config);

  // Initialize the database
  try {
    const { CloudAccountRepo } = await import('../ipc/database/cloudHandler');
    await CloudAccountRepo.init();
    const accounts = await CloudAccountRepo.getAccounts();
    logger.info(`Database initialized with ${accounts.length} account(s)`);
  } catch (error) {
    logger.warn('Failed to initialize database, some features may not work:', error);
  }

  // Start OAuth callback server
  const authServer = new StandaloneAuthServer();
  authServer.start();

  // Create and start the NestJS application
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    logger: ['error', 'warn', 'log'],
  });

  // Enable CORS
  app.enableCors();

  // Add health check endpoint
  const fastifyInstance = app.getHttpAdapter().getInstance();
  fastifyInstance.get('/health', async () => {
    return { status: 'ok', service: 'proxy-server', timestamp: new Date().toISOString() };
  });

  await app.listen(port, '0.0.0.0');
  logger.info(`Proxy server running on http://0.0.0.0:${port}`);
  logger.info('');
  logger.info('📋 Quick Start:');
  logger.info(
    `   1. Open http://localhost:${process.env.OAUTH_REDIRECT_PORT || '8888'}/auth/start in your browser`,
  );
  logger.info('   2. Complete Google OAuth authorization');
  logger.info(`   3. Use the API at http://localhost:${port}`);
  logger.info('');

  // Handle graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down...`);
    authServer.stop();
    await app.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// Run the bootstrap
bootstrap().catch((error) => {
  logger.error('Failed to start standalone proxy:', error);
  process.exit(1);
});
