// FIFO queue shared by Mode A (in-browser intercept) and Mode B (local HTTP server) so a single
// Gemini Nano session never runs concurrently with another, regardless of which mode originated
// the request (spec §2.2, §5 item 3).
export class QueueFullError extends Error {
  constructor() {
    super('Inference queue is full');
    this.name = 'QueueFullError';
  }
}

export class InferenceQueue {
  constructor(maxQueueLength = 10) {
    this.maxQueueLength = maxQueueLength;
    this.queue = [];
    this.running = false;
  }

  get length() {
    return this.queue.length;
  }

  // `task` is an async function; it runs to completion (including any streaming side effects)
  // before the next queued task starts. Rejects with QueueFullError if already at capacity.
  enqueue(task) {
    if (this.queue.length >= this.maxQueueLength) {
      throw new QueueFullError();
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject, queuedAt: Date.now() });
      this._drain();
    });
  }

  async _drain() {
    if (this.running) return;
    this.running = true;
    while (this.queue.length > 0) {
      const { task, resolve, reject, queuedAt } = this.queue.shift();
      const waitedMs = Date.now() - queuedAt;
      try {
        resolve(await task(waitedMs));
      } catch (err) {
        reject(err);
      }
    }
    this.running = false;
  }
}
