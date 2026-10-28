import { describe, expect, it } from 'vitest';
import { AssistantAreaResolver } from './area-resolver.service';

/**
 * Owner 2026-10-28 (Sol N-02): places are searched by the new administrative
 * address only. A pre-2025 district name is not mapped to its old province;
 * it is not recognised, so the assistant asks for a new address.
 */
const HCM = { code: '79', name: 'Thành phố Hồ Chí Minh' };
const BEN_THANH = {
  code: '26740',
  name: 'Bến Thành',
  fullName: 'Phường Bến Thành',
  level: 'WARD',
  parentCode: '79',
  isCurrent: true,
};
const OLD_DISTRICT = {
  code: '760',
  name: 'Quận 10',
  fullName: 'Quận 10',
  level: 'DISTRICT',
  parentCode: '79',
  isCurrent: false,
};

const resolver = new AssistantAreaResolver({
  snapshot: async () => ({ datasetVersion: 'v2025', currentProvinces: [HCM] }),
  search: (_s: unknown, o: { includeLegacy: boolean }) => ({
    items: o.includeLegacy ? [BEN_THANH, OLD_DISTRICT] : [BEN_THANH],
  }),
} as never);

describe('area resolution uses the new administrative address only', () => {
  it('a current ward resolves', async () => {
    const r = await resolver.resolve('cà phê ở Bến Thành', 'Bến Thành');
    expect(r.kind).toBe('resolved');
  });

  it('an old district is not mapped to its province', async () => {
    expect(await resolver.resolve('cà phê ở Quận 10', 'Quận 10')).toEqual({ kind: 'none' });
  });

  it('an old district with the city named is still not recognised', async () => {
    expect(await resolver.resolve('cà phê ở Quận 10 TP HCM', 'Quận 10')).toEqual({
      kind: 'none',
    });
  });

  it('a single-digit old district with the city named is not recognised', async () => {
    expect(await resolver.resolve('cà phê ở Quận 1 TP HCM', 'Quận 1')).toEqual({ kind: 'none' });
  });

  it('the city alone resolves to the city', async () => {
    const r = await resolver.resolve('cà phê ở TP HCM', null);
    expect(r.kind).toBe('resolved');
  });
});
