export class Mutex {
  private queue: Promise<void> = Promise.resolve();

  /**
   * Runs an exclusive task, ensuring only one runs at a time.
   */
  async runExclusive<T>(task: () => Promise<T> | T): Promise<T> {
    let release!: () => void;

    // Wait until the previous task in the queue completes
    const wait = this.queue;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });

    await wait;
    try {
      return await task();
    } finally {
      release(); // Notify the next task immediately
    }
  }
}
