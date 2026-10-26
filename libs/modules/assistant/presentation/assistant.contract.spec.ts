import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

/**
 * GoGo-BE#713 — the GoGo AI contract, read from the published document the
 * way a generated client reads it. Contract-first: the module that serves
 * these operations lands in a later PR, so these are the guarantees Mobile#378
 * and CMS#249 generate against, pinned before any code can drift from them.
 */
const SPEC = path.resolve(__dirname, '../../../../openapi/gogo.v1.yaml');

type Schema = Record<string, unknown> & {
  properties?: Record<string, Schema>;
  required?: string[];
  oneOf?: Schema[];
  enum?: unknown[];
  discriminator?: { propertyName: string; mapping: Record<string, string> };
  $ref?: string;
};
type Parameter = { name: string; in: string; required?: boolean; $ref?: string };
type Response = { $ref?: string; description?: string; headers?: Record<string, unknown> };
type Operation = {
  operationId: string;
  tags?: string[];
  'x-gogo-planned'?: string;
  parameters?: Parameter[];
  responses: Record<string, Response>;
  requestBody?: { content: Record<string, { schema: Schema }> };
};
type Doc = {
  paths: Record<string, Record<string, Operation>>;
  components: {
    schemas: Record<string, Schema>;
    responses: Record<string, Response>;
    parameters: Record<string, Parameter>;
  };
};

const doc = parseYaml(readFileSync(SPEC, 'utf8')) as Doc;
const op = (route: string, method: string): Operation => {
  const found = doc.paths[route]?.[method];
  if (!found) throw new Error(`${method.toUpperCase()} ${route} is not in the contract`);
  return found;
};
const schema = (name: string): Schema => {
  const found = doc.components.schemas[name];
  if (!found) throw new Error(`schema ${name} is not in the contract`);
  return found;
};
const ref = (name: string) => `#/components/schemas/${name}`;

const APP_OPERATIONS: [string, string][] = [
  ['/assistant/status', 'get'],
  ['/assistant/conversations', 'get'],
  ['/assistant/conversations', 'post'],
  ['/assistant/conversations/{id}', 'get'],
  ['/assistant/conversations/{id}', 'patch'],
  ['/assistant/conversations/{id}', 'delete'],
  ['/assistant/conversations/{id}/messages', 'get'],
  ['/assistant/conversations/{id}/messages', 'post'],
  ['/assistant/conversations/{id}/messages/{messageId}/stream', 'get'],
  ['/assistant/conversations/{id}/messages/{messageId}/stop', 'post'],
  ['/assistant/conversations/{id}/messages/{messageId}/feedback', 'put'],
  ['/assistant/conversations/{id}/messages/{messageId}/feedback', 'delete'],
  ['/assistant/proposals/{proposalId}', 'get'],
  ['/assistant/proposals/{proposalId}/confirm', 'post'],
  ['/assistant/proposals/{proposalId}/dismiss', 'post'],
];

const CMS_OPERATIONS: [string, string][] = [
  ['/cms/assistant/documents', 'get'],
  ['/cms/assistant/documents', 'post'],
  ['/cms/assistant/documents/{id}', 'get'],
  ['/cms/assistant/documents/{id}', 'patch'],
  ['/cms/assistant/documents/{id}/publish', 'post'],
  ['/cms/assistant/documents/{id}/unpublish', 'post'],
  ['/cms/assistant/documents/{id}/versions', 'get'],
  ['/cms/assistant/documents/{id}/versions/{versionId}', 'get'],
  ['/cms/assistant/feedback', 'get'],
];

describe('GoGo AI contract (GoGo-BE#713)', () => {
  it.each([...APP_OPERATIONS, ...CMS_OPERATIONS])(
    '%s %s is declared, tagged assistant and marked planned',
    (route, method) => {
      const operation = op(route, method);
      expect(operation.tags).toContain('assistant');
      expect(operation['x-gogo-planned']).toBe('GoGo-BE#713');
    },
  );

  it.each(APP_OPERATIONS)('%s %s refuses a guest session with 403 USER_ONLY', (route, method) => {
    const forbidden = op(route, method).responses['403'];
    expect(forbidden, `${route} 403`).toBeDefined();
    const description =
      forbidden!.$ref === '#/components/responses/AssistantUserOnly'
        ? doc.components.responses.AssistantUserOnly!.description
        : forbidden!.description;
    expect(description).toContain('USER_ONLY');
  });

  it.each([
    ['/assistant/conversations/{id}/messages', 'post'],
    ['/assistant/proposals/{proposalId}/confirm', 'post'],
  ])('%s %s requires Idempotency-Key', (route, method) => {
    const header = op(route, method).parameters?.find((p) => p.name === 'Idempotency-Key');
    expect(header?.in).toBe('header');
    expect(header?.required).toBe(true);
  });

  it.each([
    ['/assistant/conversations', 'post'],
    ['/assistant/conversations/{id}/messages', 'post'],
    ['/assistant/conversations/{id}/messages/{messageId}/stream', 'get'],
    ['/assistant/proposals/{proposalId}/confirm', 'post'],
  ])('%s %s declares the kill switch as 503 ASSISTANT_DISABLED', (route, method) => {
    expect(op(route, method).responses['503']?.$ref).toBe(
      '#/components/responses/AssistantDisabled',
    );
    expect(doc.components.responses.AssistantDisabled!.description).toContain('ASSISTANT_DISABLED');
  });

  it('declares the send rate limit as 429 with Retry-After', () => {
    const limited = op('/assistant/conversations/{id}/messages', 'post').responses['429'];
    expect(limited?.$ref).toBe('#/components/responses/AssistantRateLimited');
    const component = doc.components.responses.AssistantRateLimited!;
    expect(Object.keys(component.headers ?? {})).toContain('Retry-After');
    expect(component.description).toContain('ASSISTANT_DAILY_LIMIT');
  });

  it('streams the reply as text/event-stream of AssistantStreamEvent', () => {
    const ok = op('/assistant/conversations/{id}/messages/{messageId}/stream', 'get').responses[
      '200'
    ] as { content?: Record<string, { schema: Schema }> };
    expect(ok.content?.['text/event-stream']?.schema.$ref).toBe(ref('AssistantStreamEvent'));
  });

  it('covers every stream event the design renders, discriminated by type', () => {
    const event = schema('AssistantStreamEvent');
    expect(event.discriminator?.propertyName).toBe('type');
    expect(Object.keys(event.discriminator?.mapping ?? {}).sort()).toEqual(
      [
        'card',
        'delta',
        'done',
        'error',
        'follow_ups',
        'notice',
        'proposal',
        'sources',
        'step',
      ].sort(),
    );
    for (const [name, target] of Object.entries(event.discriminator!.mapping)) {
      const variant = schema(target.split('/').pop()!);
      expect(variant.properties?.type?.enum, name).toEqual([name]);
      expect(variant.required, name).toEqual(expect.arrayContaining(['type', 'seq', 'messageId']));
    }
  });

  it('says a stopped reply keeps its text and a timeout ends in a deterministic fallback', () => {
    const done = schema('AssistantStreamDone').properties!.status!;
    expect(done['x-extensible-enum']).toEqual(expect.arrayContaining(['stopped', 'fallback']));
    const notice = schema('AssistantNotice').properties!;
    expect(notice.kind!['x-extensible-enum']).toEqual(
      expect.arrayContaining(['empty', 'fallback']),
    );
    expect(notice.reason!['x-extensible-enum']).toContain('timeout');
    expect(
      op('/assistant/conversations/{id}/messages/{messageId}/stop', 'post').responses['200'],
    ).toBeDefined();
  });

  it('result cards carry ids and verified facts, never free text from the model', () => {
    const place = schema('AssistantPlaceCard');
    expect(place.required).toEqual(expect.arrayContaining(['placeId', 'facts']));
    expect(place.properties!.facts!.properties).toHaveProperty('checkedAt');
    const plan = schema('AssistantPlanCard');
    expect(plan.required).toEqual(expect.arrayContaining(['planId', 'facts']));
  });

  it('every proposal value says whether the user stated it or the assistant assumed it', () => {
    const value = schema('AssistantProposalValue');
    expect(value.required).toContain('origin');
    expect(value.properties!.origin!.enum).toEqual(['explicit', 'assumed']);
  });

  it('confirm answers with the server-saved values', () => {
    const ok = op('/assistant/proposals/{proposalId}/confirm', 'post').responses['200'] as {
      content?: Record<string, { schema: Schema }>;
    };
    expect(ok.content?.['application/json']?.schema.$ref).toBe(ref('AssistantProposalResult'));
    expect(schema('AssistantProposalResult').required).toContain('savedValues');
  });

  it('sources carry API titles, so the client never shows model-written ones', () => {
    expect(schema('AssistantSource').required).toEqual(
      expect.arrayContaining(['index', 'kind', 'title']),
    );
  });

  it('conversations carry lastMessageAt for Today / Yesterday / Earlier grouping', () => {
    expect(schema('AssistantConversation').required).toEqual(
      expect.arrayContaining(['lastMessageAt', 'expiresAt']),
    );
    const list = op('/assistant/conversations', 'get');
    expect(list.parameters?.map((p) => p.name)).toEqual(
      expect.arrayContaining(['q', 'cursor', 'limit']),
    );
    expect(schema('AssistantConversationPage').required).toContain('nextCursor');
  });

  it('attachments are image uploads only', () => {
    const uploads = op('/uploads', 'post').requestBody!.content['application/json']!.schema;
    expect(uploads.properties!.purpose!.enum).toContain('assistant_image');
    expect(schema('AssistantAttachment').properties!.contentType!.enum).toEqual([
      'image/jpeg',
      'image/png',
      'image/webp',
    ]);
  });

  it('a feedback row in the moderation queue names no user', () => {
    const item = schema('CmsAssistantFeedbackItem');
    const fields = Object.keys(item.properties ?? {});
    for (const pii of ['userId', 'email', 'userMessage', 'attachments', 'context', 'lat', 'lng']) {
      expect(fields, pii).not.toContain(pii);
    }
  });

  it('every operationId is unique to the assistant surface', () => {
    const ids = [...APP_OPERATIONS, ...CMS_OPERATIONS].map(([r, m]) => op(r, m).operationId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
