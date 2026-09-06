import { describe, expect, it } from 'vitest';
import { normalizePhone, normalizeWebsite } from './place-contact';

describe('normalizePhone', () => {
  it.each([
    ['0283 822 9999', '+842838229999'],
    ['(028) 3822-9999', '+842838229999'],
    ['+84 28 3822 9999', '+842838229999'],
    ['0084 28 3822 9999', '+842838229999'],
    ['84 28 3822 9999', '+842838229999'],
    ['0912 345 678', '+84912345678'],
  ])('normalizes %s to %s', (raw, expected) => {
    expect(normalizePhone(raw)).toEqual({ ok: true, value: expected });
  });

  it('keeps an explicitly international number in its own country', () => {
    expect(normalizePhone('+65 6221 1111')).toEqual({ ok: true, value: '+6562211111' });
  });

  it('refuses a bare subscriber number rather than assuming Vietnam', () => {
    const result = normalizePhone('3822 9999');
    expect(result).toEqual({ ok: false, issue: expect.objectContaining({ code: 'no_country' }) });
  });

  it.each(['', '   ', 'gọi cho tôi', '1900-COFFEE', '+84', '0' + '1'.repeat(20)])(
    'rejects %j',
    (raw) => {
      expect(normalizePhone(raw).ok).toBe(false);
    },
  );
});

describe('normalizeWebsite', () => {
  it('upgrades a bare host to https', () => {
    expect(normalizeWebsite('chaoban.vn')).toEqual({ ok: true, value: 'https://chaoban.vn/' });
  });

  it('keeps an http URL as http', () => {
    expect(normalizeWebsite('http://chaoban.vn/menu')).toEqual({
      ok: true,
      value: 'http://chaoban.vn/menu',
    });
  });

  it.each(['javascript:alert(1)', 'data:text/html,<script>', 'file:///etc/passwd', 'ftp://x.vn'])(
    'rejects the %j scheme — the value is rendered as an href',
    (raw) => {
      expect(normalizeWebsite(raw).ok).toBe(false);
    },
  );

  it('rejects a host with no dot', () => {
    expect(normalizeWebsite('https://localhost').ok).toBe(false);
  });

  it('rejects an empty value — clearing is a null, not an empty string', () => {
    expect(normalizeWebsite('   ').ok).toBe(false);
  });
});
