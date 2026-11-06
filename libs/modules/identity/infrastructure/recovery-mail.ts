import { AppError } from '../../shared/app-error';

export type RecoveryMail = { email: string; challengeId: string; code: string; expiresAt: Date };

export abstract class RecoveryMailSender {
  abstract assertConfigured(): void;
  /** Null is decoy work; it must follow the same adapter path. */
  abstract send(message: RecoveryMail | null): Promise<void>;
}

/** In-memory dev sink, like FakePush.sent. Never prints or sends mail. */
export class RecoveryMailSink extends RecoveryMailSender {
  private messages: RecoveryMail[] = [];

  get sent(): readonly RecoveryMail[] {
    this.messages = this.messages.filter((item) => item.expiresAt.getTime() > Date.now());
    return this.messages;
  }

  assertConfigured(): void {}

  async send(message: RecoveryMail | null): Promise<void> {
    this.messages = this.sent.slice(-99);
    if (message) this.messages.push(message);
  }
}

export class UnconfiguredRecoveryMailSender extends RecoveryMailSender {
  assertConfigured(): never {
    throw AppError.serviceUnavailable(
      'RECOVERY_MAIL_NOT_CONFIGURED',
      'Password recovery requires a configured mail adapter and shared fail-closed quotas',
      false,
    );
  }

  async send(_message: RecoveryMail | null): Promise<void> {
    this.assertConfigured();
  }
}
