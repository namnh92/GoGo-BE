import { describe, expect, it } from 'vitest';
import { planContactWrite } from './place-contact-write';

const NOW = new Date('2026-10-02T10:00:00Z');
const EV = {
  sourceType: 'editorial',
  sourceReference: 'Thực đơn in tại quán, chụp 2026-09-30',
  collectedAt: '2026-09-30T02:00:00Z',
};
const STORED = { addressText: '12 Lê Lợi', phone: '+842838229999', website: null };

describe('planContactWrite (#280)', () => {
  it('refuses a typed value with no evidence — typing does not confer ownership', () => {
    const res = planContactWrite({ phone: '0283 822 9999' }, null, NOW);
    expect(res).toEqual({
      ok: false,
      issues: [expect.objectContaining({ field: 'provenance.phone', code: 'required' })],
    });
  });

  it('writes a value with its evidence, normalized', () => {
    const res = planContactWrite({ phone: '0283 822 9999', provenance: { phone: EV } }, null, NOW);
    expect(res).toEqual({
      ok: true,
      plan: {
        values: { phone: '+842838229999' },
        claims: [
          {
            field: 'phone',
            evidence: { ...EV, collectedAt: '2026-09-30T02:00:00.000Z' },
          },
        ],
        cleared: [],
      },
    });
  });

  it('clears with null and never asks for, or accepts, evidence to do it', () => {
    expect(planContactWrite({ addressText: null }, STORED, NOW)).toEqual({
      ok: true,
      plan: { values: { addressText: null }, claims: [], cleared: ['address_text'] },
    });
    expect(
      planContactWrite({ addressText: null, provenance: { addressText: EV } }, STORED, NOW),
    ).toEqual({
      ok: false,
      issues: [expect.objectContaining({ field: 'provenance.addressText', code: 'not_allowed' })],
    });
  });

  it('treats an unchanged re-sent value as no write, and the same value with evidence as re-verification', () => {
    expect(planContactWrite({ phone: '028 3822 9999' }, STORED, NOW)).toEqual({
      ok: true,
      plan: { values: {}, claims: [], cleared: [] },
    });
    const reverified = planContactWrite(
      { phone: '028 3822 9999', provenance: { phone: EV } },
      STORED,
      NOW,
    );
    expect(reverified.ok && reverified.plan.claims.map((c) => c.field)).toEqual(['phone']);
  });

  it('refuses evidence for a field the request does not write', () => {
    expect(planContactWrite({ provenance: { website: EV } }, STORED, NOW)).toEqual({
      ok: false,
      issues: [expect.objectContaining({ field: 'provenance.website', code: 'value_missing' })],
    });
  });

  it('reports every bad field at once', () => {
    const res = planContactWrite(
      {
        addressText: '   ',
        phone: '+0912345678',
        website: 'https://u:p@chaoban.vn',
        provenance: { addressText: EV, phone: EV, website: EV },
      },
      null,
      NOW,
    );
    expect(res.ok).toBe(false);
    if (!res.ok)
      expect(res.issues.map((i) => i.field)).toEqual(['addressText', 'phone', 'website']);
  });

  it('refuses Google as the origin of a contact value', () => {
    const res = planContactWrite(
      {
        addressText: '9 Nguyễn Huệ',
        provenance: { addressText: { ...EV, sourceReference: 'https://maps.google.com/?cid=1' } },
      },
      null,
      NOW,
    );
    expect(res).toEqual({
      ok: false,
      issues: [
        expect.objectContaining({
          field: 'provenance.addressText.sourceReference',
          code: 'google_not_independent',
        }),
      ],
    });
  });
});
