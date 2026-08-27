import { Controller, Get, Header } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Public } from '@gogo/modules';

const SPEC_PATH = path.resolve(process.cwd(), 'openapi/gogo.v1.yaml');

/**
 * BE-BFF-012 — the API serves its own contract, so clients and tooling always
 * read the version actually deployed. Spec is read once at boot (immutable per
 * deploy); Swagger UI renders it for the mobile/web integrators.
 */
@Controller()
export class DocsController {
  private readonly spec = readFileSync(SPEC_PATH, 'utf8');

  @Public()
  @Get('openapi.yaml')
  @Header('content-type', 'application/yaml; charset=utf-8')
  @Header('cache-control', 'public, max-age=300')
  specYaml(): string {
    return this.spec;
  }

  /** Swagger UI over the live spec — the integration entry point for clients. */
  @Public()
  @Get('docs')
  @Header('content-type', 'text/html; charset=utf-8')
  docs(): string {
    return `<!doctype html>
<html lang="vi">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>GoGo API — integration docs</title>
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
    <style>
      body { margin: 0; background: #fafafa; }
      .topbar { display: none; }
      .gogo-banner {
        font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #211f1c; color: #f6f3ee; padding: 14px 20px;
      }
      .gogo-banner b { color: #ffb4a2; }
      .gogo-banner a { color: #ffd7cc; }
      .gogo-banner code {
        background: rgba(255,255,255,.12); padding: 1px 5px; border-radius: 4px;
      }
    </style>
  </head>
  <body>
    <div class="gogo-banner">
      <b>GoGo API</b> — generate your client from
      <a href="/v1/openapi.yaml"><code>/v1/openapi.yaml</code></a>; do not hand-write DTOs.
      Mobile uses bearer tokens (Keychain/Keystore), rotating refresh, and
      <code>Idempotency-Key</code> on retryable mutations. Read the description
      block below before wiring the first screen.
    </div>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js" crossorigin></script>
    <script>
      window.ui = SwaggerUIBundle({
        url: '/v1/openapi.yaml',
        dom_id: '#swagger-ui',
        deepLinking: true,
        docExpansion: 'none',
        defaultModelsExpandDepth: 1,
        tryItOutEnabled: true,
        persistAuthorization: true,
        filter: true,
        tagsSorter: 'alpha',
        operationsSorter: 'alpha',
      });
    </script>
  </body>
</html>`;
  }
}
