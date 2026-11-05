import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const SPEC = path.resolve(__dirname, '../../../../openapi/gogo.v1.yaml');

interface SchemaObject {
  type?: string;
  enum?: string[];
  required?: string[];
  properties?: Record<string, SchemaObject>;
  'x-extensible-enum'?: string[];
}

const doc = parseYaml(readFileSync(SPEC, 'utf8')) as {
  components: { schemas: Record<string, SchemaObject> };
};

describe('Notification payload contract (#753)', () => {
  it('declares campaign as an inbox kind', () => {
    expect(doc.components.schemas.NotificationKind?.['x-extensible-enum']).toContain('campaign');
  });

  it('declares every display fact as an additive optional payload property', () => {
    const payload = doc.components.schemas.Notification?.properties?.payload;
    expect(payload).toBeDefined();
    if (!payload) throw new Error('Notification.payload is missing');

    expect(payload.properties?.roomName?.type).toBe('string');
    expect(payload.properties?.inviterName?.type).toBe('string');
    expect(payload.properties?.preferenceProgress).toMatchObject({
      type: 'object',
      required: ['completedCount', 'memberCount'],
      properties: {
        completedCount: { type: 'integer' },
        memberCount: { type: 'integer' },
      },
    });
    expect(payload.properties?.stopCount?.type).toBe('integer');
    expect(payload.properties?.planChange).toMatchObject({
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['edit', 'regenerate'] },
        stopCount: { type: 'integer' },
        optionalStopCount: { type: 'integer' },
        addedStopCount: { type: 'integer' },
        removedStopCount: { type: 'integer' },
        movedStopCount: { type: 'integer' },
        durationChangedStopCount: { type: 'integer' },
        lockChangedStopCount: { type: 'integer' },
        optionalChangedStopCount: { type: 'integer' },
      },
    });
    expect(payload.properties?.planChange?.required).toEqual(['action']);
    expect(payload.properties?.title?.type).toBe('string');
    expect(payload.properties?.body?.type).toBe('string');

    for (const field of [
      'roomName',
      'inviterName',
      'preferenceProgress',
      'stopCount',
      'planChange',
      'title',
      'body',
    ]) {
      expect(payload.required ?? []).not.toContain(field);
    }
  });
});
