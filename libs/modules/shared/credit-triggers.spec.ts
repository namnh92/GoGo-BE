import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CREDIT_TRIGGERS,
  creditEntitlementKey,
  creditSubjectKey,
  matchesCreditCondition,
  validateCreditRule,
} from './credit-triggers';
import { legacyCreditEntitlements } from './credit-grants';
import { CREDIT_SEEDS } from './credit-catalogue';

const user = randomUUID(),
  submissionId = randomUUID(),
  placeId = randomUUID();
const facts = {
  submissionId,
  googlePlaceId: 'ABC',
  venueIdentity: 'google:ABC',
  decision: 'approved',
  variant: 'approved',
  approvedEvidenceCount: 1,
  recipientUserId: user,
  grantOwner: 'evaluator',
};
const decode = CREDIT_TRIGGERS['place.submission_decided']!.decoders[2]!;
const event = () => {
  if (typeof decode !== 'function') throw new Error();
  return decode(facts);
};
describe('#829 versioned credit trigger registry', () => {
  it('decodes trigger facts and uses business keys after source deletion', () => {
    expect(creditEntitlementKey('per_venue', event(), randomUUID(), 'subject', 'individual')).toBe(
      'venue:google:ABC',
    );
    expect(creditEntitlementKey('per_source', event(), randomUUID(), 'subject', 'individual')).toBe(
      `submission:${submissionId}`,
    );
    expect(
      creditEntitlementKey('per_subject', event(), randomUUID(), 'subject', 'individual'),
    ).toBe('subj:subject');
    expect(
      creditEntitlementKey(
        'per_place_subject',
        { ...event(), facts: { placeId } },
        randomUUID(),
        'subject',
        'individual',
      ),
    ).toBe(`place:${placeId}:subject`);
    const id = randomUUID();
    expect(creditEntitlementKey('per_occurrence', event(), id, 'subject', 'individual')).toBe(
      `evt:${id}:subject`,
    );
    expect(
      creditEntitlementKey(
        'per_source',
        { ...event(), sourceType: 'room' },
        id,
        'subject',
        'group',
      ),
    ).toBe(`room:${submissionId}:subject`);
  });
  it.each([null, undefined])('accepts an erased nullable recipient %s as no subject', (value) => {
    if (typeof decode !== 'function') throw new Error();
    expect(decode({ ...facts, recipientUserId: value }).userIds).toEqual([]);
  });
  it('keeps v1 historical while v2 remains independently decodable', () => {
    expect(CREDIT_TRIGGERS['place.submission_decided']!.decoders[1]).toBe('historical');
    expect(event().userIds).toEqual([user]);
  });
  it('rejects incomplete/invalid payloads and invalid evidence', () => {
    if (typeof decode !== 'function') throw new Error();
    expect(() => decode({ ...facts, venueIdentity: undefined })).toThrow();
    const evidence = CREDIT_TRIGGERS['place.submission_evidence_approved']!.decoders[2];
    if (typeof evidence !== 'function') throw new Error();
    expect(() => evidence({ ...facts, approvedEvidenceCount: 0 })).toThrow();
  });
  it('excludes unsupported analytics/member triggers and scopes', () => {
    expect(() =>
      validateCreditRule('member.joined', 'individual', 'per_source', { all: [] }),
    ).toThrowError(expect.objectContaining({ code: 'TRIGGER_AUDIENCE_UNSUPPORTED' }));
    expect(() =>
      validateCreditRule('review.published', 'individual', 'per_venue', { all: [] }),
    ).toThrowError(expect.objectContaining({ code: 'DEDUP_SCOPE_UNSUPPORTED' }));
    expect(() =>
      validateCreditRule('room.completed', 'individual', 'per_source', { all: [] }),
    ).toThrow();
  });
  it('allows payload facts and subject.key; rejects unknown/provider facts, excess depth/leaves/operators', () => {
    validateCreditRule('room.completed', 'group', 'per_source', {
      all: [
        { fact: 'room.participantCount', op: 'gte', value: 3 },
        { fact: 'subject.key', op: 'in', value: ['k'] },
      ],
    });
    for (const condition of [
      { all: [{ fact: 'provider.rating', op: 'gte', value: 4 }] },
      { fact: 'decision', op: 'execute', value: 'approved' },
      { all: [{ all: [{ all: [] }] }] },
      {
        all: Array.from({ length: 11 }, () => ({ fact: 'decision', op: 'eq', value: 'approved' })),
      },
      { fact: 'decision', op: 'in', value: 'approved' },
      { fact: 'approvedEvidenceCount', op: 'gte', value: '1' },
    ])
      expect(() =>
        validateCreditRule('place.submission_decided', 'individual', 'per_venue', condition),
      ).toThrowError(expect.objectContaining({ code: 'CONDITION_INVALID' }));
  });
  it('evaluates all declarative operators without current/live facts', () => {
    for (const condition of [
      { fact: 'decision', op: 'eq', value: 'approved' },
      { fact: 'decision', op: 'neq', value: 'rejected' },
      { fact: 'decision', op: 'in', value: ['approved'] },
      { fact: 'approvedEvidenceCount', op: 'gte', value: 1 },
      { fact: 'approvedEvidenceCount', op: 'lte', value: 1 },
      { fact: 'missing', op: 'exists', value: false },
    ] as const)
      expect(matchesCreditCondition(condition as never, facts)).toBe(true);
    expect(
      matchesCreditCondition({ any: [{ fact: 'decision', op: 'eq', value: 'rejected' }] }, facts),
    ).toBe(false);
  });
  it('uses a stable dedicated secret, never a raw user id', () => {
    const key = creditSubjectKey('s'.repeat(32), user);
    expect(key).toHaveLength(32);
    expect(key).not.toContain(user);
    expect(creditSubjectKey('s'.repeat(32), user)).toBe(key);
    expect(creditSubjectKey('s'.repeat(32), randomUUID())).not.toBe(key);
    expect(() => creditSubjectKey('', user)).toThrow();
  });
  it.each([20, 50, 70])(
    'maps historical %i with one venue prefix and unchanged evidence entitlement',
    (delta) => {
      const row = {
        id: randomUUID(),
        user_id: user,
        delta,
        submission_id: submissionId,
        venue_identity: 'google:ABC',
        credit_event_id: null,
      };
      const keys = legacyCreditEntitlements(row);
      expect(keys[0]).toEqual({ eventId: CREDIT_SEEDS[0].id, key: 'venue:google:ABC' });
      expect(keys).toHaveLength(delta === 50 ? 1 : 2);
      if (delta !== 50)
        expect(keys[1]).toEqual({ eventId: CREDIT_SEEDS[1].id, key: `submission:${submissionId}` });
      expect(row.delta).toBe(delta);
    },
  );
});
