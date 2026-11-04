import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  deviceExternalId,
  deviceSecretMatches,
  hashDeviceSecret,
  isDeviceExternalId,
  parseDeviceAuthorization,
} from './device-identity';

const SECRET = 'a'.repeat(43);

describe('the device: namespace (NTF-BE-017)', () => {
  it('builds only from a uuid', () => {
    const id = randomUUID();
    expect(deviceExternalId(id)).toBe(`device:${id}`);
    expect(isDeviceExternalId(`device:${id}`)).toBe(true);
    for (const bad of ['', 'someone', `device:${id}`, `${id}/../x`]) {
      expect(() => deviceExternalId(bad), bad).toThrow(/uuid/);
    }
  });

  it('a user id is never in it', () => {
    expect(isDeviceExternalId(randomUUID())).toBe(false);
  });
});

describe('the device credential', () => {
  it('parses the scheme and lowercases the id', () => {
    const id = randomUUID();
    expect(parseDeviceAuthorization(`Device ${id.toUpperCase()}.${SECRET}`)).toEqual({
      deviceId: id,
      secret: SECRET,
    });
  });

  it('refuses anything else with 401', () => {
    const id = randomUUID();
    for (const bad of [
      undefined,
      '',
      `Bearer ${id}.${SECRET}`,
      `Device ${id}`,
      `Device ${id}.short`,
      `Device not-a-uuid-not-a-uuid-not-a-uuid-xxxx.${SECRET}`,
      `Device ${id}.${SECRET}; drop`,
    ]) {
      expect(() => parseDeviceAuthorization(bad), String(bad)).toThrow(
        expect.objectContaining({ code: 'DEVICE_CREDENTIAL_REQUIRED', httpStatus: 401 }),
      );
    }
  });

  it('compares by hash', () => {
    const hash = hashDeviceSecret(SECRET);
    expect(hash).not.toContain(SECRET);
    expect(deviceSecretMatches(SECRET, hash)).toBe(true);
    expect(deviceSecretMatches('b'.repeat(43), hash)).toBe(false);
    expect(deviceSecretMatches(SECRET, 'x')).toBe(false);
  });
});
