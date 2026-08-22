export class TransitionWriteQueue {
  private pending: Promise<void> = Promise.resolve();

  enqueue(write: () => Promise<void>): Promise<void> {
    const next = this.pending.catch(() => {}).then(write);
    this.pending = next;
    return next;
  }

  settle(): Promise<void> {
    return this.pending.catch(() => {});
  }
}
