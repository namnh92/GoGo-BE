import { afterEach, describe, expect, it, vi } from 'vitest';
import { SendEmailCommand } from '@aws-sdk/client-sesv2';
import type * as SesSdk from '@aws-sdk/client-sesv2';
import { SdkRecoverySesClient, type RecoverySesEmail } from './recovery-mail-ses';

const sdk = vi.hoisted(() => ({ construct: vi.fn(), send: vi.fn() }));
vi.mock('@aws-sdk/client-sesv2', async (importOriginal) => ({
  ...(await importOriginal<typeof SesSdk>()),
  SESv2Client: class {
    constructor(options: unknown) {
      sdk.construct(options);
    }
    send = sdk.send;
  },
}));

afterEach(() => vi.clearAllMocks());

describe('SES SDK bridge (#777)', () => {
  it('uses SendEmailCommand, bounded timeouts, one attempt and default credentials', async () => {
    sdk.send.mockResolvedValue({ MessageId: 'discarded' });
    const client = new SdkRecoverySesClient('ap-southeast-1');
    const input: RecoverySesEmail = {
      FromEmailAddress: 'recovery@example.com',
      ConfigurationSetName: 'recovery-test',
      Destination: { ToAddresses: ['recipient@example.com'] },
      Content: {
        Simple: {
          Subject: { Data: 'subject', Charset: 'UTF-8' },
          Body: { Text: { Data: 'body', Charset: 'UTF-8' } },
        },
      },
    };
    await expect(client.sendEmail(input)).resolves.toBeUndefined();
    expect(sdk.construct).toHaveBeenCalledExactlyOnceWith({
      region: 'ap-southeast-1',
      maxAttempts: 1,
      requestHandler: {
        connectionTimeout: 1_000,
        requestTimeout: 3_000,
        throwOnRequestTimeout: true,
      },
    });
    expect(sdk.send).toHaveBeenCalledTimes(1);
    const command = sdk.send.mock.calls[0]![0];
    expect(command).toBeInstanceOf(SendEmailCommand);
    expect(command.input).toEqual(input);
  });
});
