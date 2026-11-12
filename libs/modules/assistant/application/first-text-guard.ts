/** The first-text deadline passed before any stage produced text. */
export class FirstTextDeadlineError extends Error {
  constructor() {
    super('assistant first-text deadline passed');
    this.name = 'FirstTextDeadlineError';
  }
}

export type FirstTextGuard = {
  /**
   * Aborts when the deadline passes (until released) or the turn is aborted:
   * a stage hands it to provider calls so abandoned work cannot start or
   * continue paid calls (A-R2-06).
   */
  readonly signal: AbortSignal;
  /**
   * The stage's result, unless the deadline passes or the turn is aborted
   * first. Lazy, so a stage the deadline already refused never starts.
   */
  run<T>(work: () => Promise<T>): Promise<T>;
  /** Text is about to start (or the compose stage owns the deadline from here). */
  release(): void;
  dispose(): void;
};

export function firstTextGuard(deadline: number, signal: AbortSignal): FirstTextGuard {
  let released = false;
  let expire: (() => void) | null = null;
  const expired = new Promise<never>((_resolve, reject) => {
    expire = () => reject(new FirstTextDeadlineError());
  });
  expired.catch(() => undefined);
  const deadlineController = new AbortController();
  const timer = setTimeout(
    () => {
      deadlineController.abort(new FirstTextDeadlineError());
      expire?.();
    },
    Math.max(0, deadline - Date.now()),
  );
  timer.unref?.();
  return {
    signal: AbortSignal.any([signal, deadlineController.signal]),
    async run<T>(stage: () => Promise<T>): Promise<T> {
      signal.throwIfAborted();
      if (released) return stage();
      if (Date.now() >= deadline) throw new FirstTextDeadlineError();
      const work = stage();
      const aborted = new Promise<never>((_resolve, reject) => {
        const onAbort = () => reject(signal.reason ?? new Error('aborted'));
        signal.addEventListener('abort', onAbort, { once: true });
        void work
          .finally(() => signal.removeEventListener('abort', onAbort))
          .catch(() => undefined);
      });
      aborted.catch(() => undefined);
      work.catch(() => undefined);
      return Promise.race([work, expired, aborted]);
    },
    release() {
      released = true;
      clearTimeout(timer);
    },
    dispose() {
      clearTimeout(timer);
    },
  };
}
