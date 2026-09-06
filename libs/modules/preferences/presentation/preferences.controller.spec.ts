import { readFileSync } from 'node:fs';
import path from 'node:path';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import { PreferencesController } from './preferences.controller';

/**
 * The status code a route answers with is part of the contract, not an
 * implementation detail: the generated TypeScript clients type the response off
 * the declared code, so a route answering 201 where the spec says 200 hands
 * every consumer a shape it has no branch for.
 *
 * `POST .../preferences/complete` did exactly that — Nest defaults POST to 201
 * and the OpenAPI file declares 200. The integration test asserted the body and
 * never the code, so the drift was invisible until an end-to-end run against DEV
 * compared the two (GoGo-BE#448).
 */
const SPEC = path.resolve(__dirname, '../../../../openapi/gogo.v1.yaml');

/** Success codes the spec declares for one `METHOD path` operation. */
function declaredSuccessCodes(operationId: string): string[] {
  const text = readFileSync(SPEC, 'utf8');
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.includes(`operationId: ${operationId}`));
  if (start === -1) throw new Error(`operationId ${operationId} not found in ${SPEC}`);

  const codes: string[] = [];
  let inResponses = false;
  for (const line of lines.slice(start)) {
    if (/^ {6}responses:\s*$/.test(line)) {
      inResponses = true;
      continue;
    }
    if (!inResponses) continue;
    // The next operation (or the next path) starts at a shallower indent than
    // the response map's own keys.
    if (/^ {0,6}\S/.test(line)) break;
    const match = /^ {8}'?(\d{3})'?:/.exec(line);
    if (match) codes.push(match[1]!);
  }
  return codes.filter((code) => code.startsWith('2'));
}

describe('PreferencesController', () => {
  it('completeMine answers the status code the spec declares', () => {
    const declared = declaredSuccessCodes('completeMyPreferences');
    expect(declared).toEqual(['200']);

    const explicit = Reflect.getMetadata(HTTP_CODE_METADATA, PreferencesController.prototype.completeMine);
    // Nest's default for @Post is 201, so the decorator has to be present.
    expect(explicit).toBe(Number(declared[0]));
  });
});
