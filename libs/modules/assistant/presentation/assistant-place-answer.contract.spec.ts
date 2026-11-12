import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { AppError } from '../../shared/app-error';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import { sendMessageBody } from './dtos';
const spec = parse(readFileSync(resolve(__dirname, '../../../../openapi/gogo.v1.yaml'), 'utf8'));
describe('S1 contract 10.1 follow-up compatibility floor', () => {
  it('reserves both-or-neither source binding without adding required fields for existing clients', () => {
    expect(spec.info.version).toBe('10.3.0-alpha.1');
    const send = spec.components.schemas.AssistantMessageSend;
    expect(send.required).toEqual(['text']);
    // A MINOR adds no request constraint: oasdiff reports a dependency keyword
    // as `request-body-dependent-required-added` (breaking). The pairing is
    // documented on the fields and enforced by the server instead.
    for (const keyword of ['dependentRequired', 'dependencies', 'dependentSchemas', 'allOf'])
      expect(send).not.toHaveProperty(keyword);
    expect(send.description).toMatch(/both or neither/i);
    for (const [field, pair] of [
      ['replyToMessageId', 'followUpOptionId'],
      ['followUpOptionId', 'replyToMessageId'],
    ] as const) {
      expect(send.properties[field]['x-gogo-planned']).toBeUndefined();
      expect(send.properties[field].description).toContain(pair);
      expect(send.properties[field].description).toMatch(/alone it is a 400/);
    }
  });
  it.each([
    ['replyToMessageId alone', { replyToMessageId: '10000000-0000-4000-8000-000000000002' }],
    ['followUpOptionId alone', { followUpOptionId: 'hours' }],
  ])('server refuses %s with the validation envelope', (_name, fields) => {
    const pipe = new ZodValidationPipe(sendMessageBody);
    expect(pipe.transform({ text: 'hello' }, { type: 'body' })).toEqual({ text: 'hello' });
    let thrown: unknown;
    try {
      pipe.transform({ text: 'hello', ...fields }, { type: 'body' });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(AppError);
    const error = thrown as AppError;
    expect(error.httpStatus).toBe(400);
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.options.fieldErrors?.length).toBeGreaterThan(0);
  });
  it('accepts the paired fields for S3 source validation', () => {
    expect(
      sendMessageBody.parse({
        text: '1',
        replyToMessageId: '10000000-0000-4000-8000-000000000002',
        followUpOptionId: 'pick_1',
      }),
    ).toHaveProperty('followUpOptionId', 'pick_1');
  });
  it('retains six options and all label/text bounds; optional id is reserved until S3/S4', () => {
    const options = spec.components.schemas.AssistantFollowUpGroup.properties.options;
    expect(options.maxItems).toBe(6);
    expect(options.items.required).toEqual(['label', 'text']);
    expect(options.items.properties.id.maxLength).toBe(64);
    expect(options.items.properties.id['x-gogo-planned']).toBeUndefined();
    expect(options.items.properties.label.maxLength).toBe(40);
    expect(options.items.properties.text.maxLength).toBe(200);
  });
});
