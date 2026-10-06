import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EXPORT_ENVELOPE_OVERHEAD,
  ExportIntegrityError,
  ExportKeyUnavailableError,
  ExportKeyringConfigError,
  ExportTooLargeError,
  openExport,
  parseExportKeyring,
  sealExport,
  serializeBounded,
} from './export-envelope';

const key = () => randomBytes(32).toString('base64');
const ids = {
  exportId: '7d0c5c0e-3d1a-4a39-9a55-1f6a2b1c0d01',
  subjectUserId: 'a1b2c3d4-0000-4000-8000-000000000001',
};
const plaintext = () => Buffer.from(JSON.stringify({ profile: { email: 'marker@example.com' } }));

describe('export keyring (GoGo-BE#256)', () => {
  it('is null when no key is configured — unavailable, never open', () => {
    expect(parseExportKeyring({})).toBeNull();
    expect(parseExportKeyring({ EXPORT_WRAPPING_KEY_V1: '' })).toBeNull();
  });

  it('refuses a key that is not 32 base64 bytes', () => {
    expect(() => parseExportKeyring({ EXPORT_WRAPPING_KEY_V1: 'short' })).toThrow(
      ExportKeyringConfigError,
    );
    expect(() =>
      parseExportKeyring({ EXPORT_WRAPPING_KEY_V1: randomBytes(16).toString('base64') }),
    ).toThrow(ExportKeyringConfigError);
  });

  it('defaults the active version to the highest, and honours an explicit one', () => {
    const env = { EXPORT_WRAPPING_KEY_V1: key(), EXPORT_WRAPPING_KEY_V2: key() };
    expect(parseExportKeyring(env)!.activeVersion).toBe(2);
    expect(parseExportKeyring({ ...env, EXPORT_WRAPPING_KEY_ACTIVE: 1 })!.activeVersion).toBe(1);
    expect(() => parseExportKeyring({ ...env, EXPORT_WRAPPING_KEY_ACTIVE: '3' })).toThrow(
      ExportKeyringConfigError,
    );
  });
});

describe('export envelope (ADR-0033 §1)', () => {
  const keyring = parseExportKeyring({ EXPORT_WRAPPING_KEY_V1: key() })!;

  it('round-trips, and the stored object carries no plaintext', () => {
    const sealed = sealExport(plaintext(), ids, keyring);
    expect(sealed.object.includes(Buffer.from('marker@example.com'))).toBe(false);
    expect(sealed.object.byteLength).toBe(plaintext().byteLength + EXPORT_ENVELOPE_OVERHEAD);
    expect(sealed.wrappedKey.byteLength).toBe(32);
    expect(openExport(sealed.object, sealed, ids, keyring).equals(plaintext())).toBe(true);
  });

  it('uses a fresh data key and nonce per artifact', () => {
    const a = sealExport(plaintext(), ids, keyring);
    const b = sealExport(plaintext(), ids, keyring);
    expect(a.object.equals(b.object)).toBe(false);
    expect(a.wrappedKey.equals(b.wrappedKey)).toBe(false);
  });

  it.each([
    ['first ciphertext byte', (o: Buffer) => flipAt(o, 16)],
    ['last tag byte', (o: Buffer) => flipAt(o, o.length - 1)],
    ['nonce', (o: Buffer) => flipAt(o, 5)],
  ])('a flipped %s fails authentication before any plaintext is returned', (_label, flip) => {
    const sealed = sealExport(plaintext(), ids, keyring);
    const tampered = Buffer.from(sealed.object);
    flip(tampered);
    let returned: Buffer | undefined;
    expect(() => {
      returned = openExport(tampered, sealed, ids, keyring);
    }).toThrow(ExportIntegrityError);
    expect(returned).toBeUndefined();
  });

  it('a truncated or foreign object fails as a format error', () => {
    const sealed = sealExport(plaintext(), ids, keyring);
    expect(() => openExport(sealed.object.subarray(0, 10), sealed, ids, keyring)).toThrow(
      ExportIntegrityError,
    );
    const foreign = Buffer.from(sealed.object);
    foreign[0] = 0x00;
    expect(() => openExport(foreign, sealed, ids, keyring)).toThrow(/format/);
  });

  it('is bound to its export id and subject (AAD)', () => {
    const sealed = sealExport(plaintext(), ids, keyring);
    expect(() =>
      openExport(sealed.object, sealed, { ...ids, exportId: randomUUIDish() }, keyring),
    ).toThrow(ExportIntegrityError);
    expect(() =>
      openExport(sealed.object, sealed, { ...ids, subjectUserId: randomUUIDish() }, keyring),
    ).toThrow(ExportIntegrityError);
  });

  it('a tampered wrapped key fails at unwrap', () => {
    const sealed = sealExport(plaintext(), ids, keyring);
    const wrappedKey = Buffer.from(sealed.wrappedKey);
    flipAt(wrappedKey, 0);
    expect(() => openExport(sealed.object, { ...sealed, wrappedKey }, ids, keyring)).toThrow(
      /unwrap/,
    );
  });

  it('rotation: a new active key still opens what the old one wrapped', () => {
    const v1 = key();
    const before = parseExportKeyring({ EXPORT_WRAPPING_KEY_V1: v1 })!;
    const sealed = sealExport(plaintext(), ids, before);
    const after = parseExportKeyring({
      EXPORT_WRAPPING_KEY_V1: v1,
      EXPORT_WRAPPING_KEY_V2: key(),
    })!;
    expect(after.activeVersion).toBe(2);
    expect(openExport(sealed.object, sealed, ids, after).equals(plaintext())).toBe(true);
    expect(sealExport(plaintext(), ids, after).keyVersion).toBe(2);
  });

  it('a missing key version fails closed', () => {
    const sealed = sealExport(plaintext(), ids, keyring);
    const other = parseExportKeyring({ EXPORT_WRAPPING_KEY_V2: key() })!;
    expect(() => openExport(sealed.object, sealed, ids, other)).toThrow(ExportKeyUnavailableError);
    expect(() => openExport(sealed.object, sealed, ids, null)).toThrow(ExportKeyUnavailableError);
  });

  it('a different key under the same version number fails authentication', () => {
    const sealed = sealExport(plaintext(), ids, keyring);
    const impostor = parseExportKeyring({ EXPORT_WRAPPING_KEY_V1: key() })!;
    expect(() => openExport(sealed.object, sealed, ids, impostor)).toThrow(ExportIntegrityError);
  });
});

describe('bounded serialization', () => {
  it('matches JSON.stringify under the limit', () => {
    const doc = {
      exportedAt: '2026-10-05T00:00:00.000Z',
      profile: { displayName: 'Lan', email: null, nested: { a: [1, 2] } },
      skipped: undefined,
      saved: [
        { type: 'place', id: 'x' },
        { type: 'plan', id: 'y' },
      ],
      empty: [],
    };
    expect(serializeBounded(doc, 10_000).toString('utf8')).toBe(JSON.stringify(doc));
  });

  it('counts UTF-8 bytes, not characters, and refuses past the limit — never truncates', () => {
    const doc = { reviews: Array.from({ length: 50 }, () => ({ text: 'Rất ngon' })) };
    const exact = Buffer.byteLength(JSON.stringify(doc), 'utf8');
    expect(serializeBounded(doc, exact).byteLength).toBe(exact);
    expect(() => serializeBounded(doc, exact - 1)).toThrow(ExportTooLargeError);
  });
});

/*
 * ADR-0033 §1: "No plaintext temporary files." The privacy module and the
 * export builder must never reach for the filesystem; this guard fails the
 * moment one of them imports it.
 */
describe('no plaintext temporary files', () => {
  it('nothing under libs/modules/privacy or the export builder imports a filesystem API', () => {
    const root = path.resolve(__dirname, '..');
    const files: string[] = [path.resolve(root, '../reviews/application/user-export.ts')];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (name.endsWith('.ts') && !name.endsWith('.spec.ts')) files.push(full);
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(4);
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/from ['"](node:)?(fs|fs\/promises|os)['"]/);
      expect(text, file).not.toMatch(/\b(tmpdir|mkdtemp|createWriteStream|writeFile)\b/);
    }
  });
});

function randomUUIDish(): string {
  return 'ffffffff-0000-4000-8000-000000000999';
}

function flipAt(buf: Buffer, index: number): void {
  buf.writeUInt8(buf.readUInt8(index) ^ 0x01, index);
}
