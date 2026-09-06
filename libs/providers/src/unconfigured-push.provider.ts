import {
  ProviderConfigurationError,
  type NotificationProviderPort,
  type PushSendResult,
  type UserNotification,
} from './ports';

/**
 * NTF-BE-002 (#193) — bound when the process is *meant* to be on OneSignal but
 * has no credential. Mirrors `UnconfiguredPlaceProvider` (#279): a missing
 * secret must never bind the fake, because the fake answers "sent" to nobody.
 *
 * Every send fails with a configuration fault the dispatcher counts and the
 * boot log names. Boot itself is not refused: push is an asynchronous
 * dependency, and a worker that will not start over a push key also stops
 * running imports and privacy jobs (spec §48).
 */
export class UnconfiguredPushProvider implements NotificationProviderPort {
  sendToUser(_userId: string, _notification: UserNotification): Promise<PushSendResult> {
    return Promise.reject(new ProviderConfigurationError('onesignal.push', 'MISSING_CREDENTIAL'));
  }

  sendToUsers(
    _userIds: readonly string[],
    _notification: UserNotification,
  ): Promise<PushSendResult> {
    return Promise.reject(new ProviderConfigurationError('onesignal.push', 'MISSING_CREDENTIAL'));
  }
}
