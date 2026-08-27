import { Controller, Get, Header } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Public } from '@gogo/modules';

const SPEC_PATH = path.resolve(process.cwd(), 'openapi/gogo.v1.yaml');

/**
 * BE-BFF-012 — the contract is served by the API itself so tooling and
 * consumers always fetch the version actually deployed. Spec is loaded once
 * at boot (immutable per deploy).
 */
@Controller()
export class DocsController {
  private readonly spec = readFileSync(SPEC_PATH, 'utf8');

  @Public()
  @Get('openapi.yaml')
  @Header('content-type', 'application/yaml; charset=utf-8')
  @Header('cache-control', 'public, max-age=300')
  spec_(): string {
    return this.spec;
  }

  /** Human-readable API docs — self-contained page rendering the live spec. */
  @Public()
  @Get('docs')
  @Header('content-type', 'text/html; charset=utf-8')
  docs(): string {
    return `<!doctype html>
<html>
  <head>
    <title>GoGo API</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <script id="api-reference" data-url="/v1/openapi.yaml"></script>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
  </body>
</html>`;
  }
}
