import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { AppError } from '../../shared/app-error';
import {
  RecoveryMailSender,
  UnconfiguredRecoveryMailSender,
  type RecoveryMail,
} from './recovery-mail';

/** SESv2 SendEmailInput subset passed to SendEmailCommand by the SDK bridge. */
export type RecoverySesEmail = {
  FromEmailAddress: string;
  ConfigurationSetName: string;
  Destination: { ToAddresses: string[] };
  Content: {
    Simple: {
      Subject: { Data: string; Charset: 'UTF-8' };
      Body: { Text: { Data: string; Charset: 'UTF-8' } };
    };
  };
};

/** Narrow seam for provider-free adapter tests. */
export interface RecoverySesClient {
  sendEmail(input: RecoverySesEmail): Promise<unknown>;
}

export type RecoverySesConfig = {
  sender: string;
  region: string;
  configurationSet: string;
};

export class SdkRecoverySesClient implements RecoverySesClient {
  private readonly client: SESv2Client;

  constructor(region: string) {
    this.client = new SESv2Client({
      region,
      // A timed-out send may already have delivered the code. Never retry it.
      maxAttempts: 1,
      requestHandler: {
        connectionTimeout: 1_000,
        requestTimeout: 3_000,
        throwOnRequestTimeout: true,
      },
      // Credentials come only through the SDK default chain (SSM → deploy env).
    });
  }

  async sendEmail(input: RecoverySesEmail): Promise<void> {
    await this.client.send(new SendEmailCommand(input));
  }
}

const templates = {
  vi: {
    subject: 'GoGo: Khôi phục mật khẩu',
    body: (code: string, expiresAt: string) =>
      `Mã khôi phục mật khẩu GoGo của bạn: ${code}\nMã hết hạn lúc ${expiresAt} (UTC).\nKhông chia sẻ mã này với bất kỳ ai. Nếu bạn không yêu cầu khôi phục mật khẩu, hãy bỏ qua email này.`,
  },
  en: {
    subject: 'GoGo: Reset your password',
    body: (code: string, expiresAt: string) =>
      `Your GoGo password recovery code: ${code}\nThis code expires at ${expiresAt} (UTC).\nDo not share this code with anyone. If you did not request a password reset, ignore this email.`,
  },
};

/** No logging, provider response retention, tags, links, or account identifiers. */
export class SesRecoveryMailSender extends RecoveryMailSender {
  override readonly adapter = 'ses' as const;
  constructor(
    private readonly client: RecoverySesClient,
    private readonly config: RecoverySesConfig,
  ) {
    super();
  }

  assertConfigured(): void {
    if (
      !this.config.sender.trim() ||
      !this.config.region.trim() ||
      !this.config.configurationSet.trim()
    ) {
      new UnconfiguredRecoveryMailSender().assertConfigured();
    }
  }

  async send(message: RecoveryMail | null): Promise<void> {
    this.assertConfigured();
    // Missing/ineligible accounts enter the adapter but never reach SES.
    if (!message) return;
    const template = templates[message.locale ?? 'vi'];
    try {
      await this.client.sendEmail({
        FromEmailAddress: this.config.sender,
        ConfigurationSetName: this.config.configurationSet,
        Destination: { ToAddresses: [message.email] },
        Content: {
          Simple: {
            Subject: { Data: template.subject, Charset: 'UTF-8' },
            Body: {
              Text: {
                Data: template.body(message.code, message.expiresAt.toISOString()),
                Charset: 'UTF-8',
              },
            },
          },
        },
      });
    } catch {
      // SDK errors may contain addresses/payloads. Never attach the original cause.
      throw AppError.serviceUnavailable(
        'RECOVERY_UNAVAILABLE',
        'Password recovery is temporarily unavailable',
      );
    }
  }
}
