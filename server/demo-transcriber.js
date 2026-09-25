const DEMO_SCRIPT = [
  'Welcome to Nerdearla. Today we are going to build an open source accessibility platform.',
  'Our architecture uses Kubernetes, WebSockets, Gemini and Redis Streams.',
  'The important part is not only accuracy, but also latency and simple operation.',
  'One operator can monitor many rooms while the audience reads captions on any device.',
];

export class DemoTranscriber {
  constructor(callbacks) {
    this.callbacks = callbacks;
    this.bytes = 0;
    this.nextIndex = 0;
    this.closed = false;
  }

  async connect() {
    setTimeout(() => this.callbacks.onOpen?.(), 50);
  }

  send(buffer) {
    if (this.closed) return;
    this.bytes += buffer.byteLength;
    const audioMs = this.bytes / 2 / 16_000 * 1_000;
    const dueIndex = Math.floor(audioMs / 3_500);
    if (this.nextIndex < DEMO_SCRIPT.length && dueIndex >= this.nextIndex) {
      const text = DEMO_SCRIPT[this.nextIndex];
      this.callbacks.onInterim?.(text.slice(0, Math.max(12, Math.floor(text.length * 0.72))));
      const current = this.nextIndex++;
      setTimeout(() => this.callbacks.onFinal?.(DEMO_SCRIPT[current]), 400);
    }
  }

  async end() {
    if (this.closed) return;
    this.closed = true;
    if (this.nextIndex < DEMO_SCRIPT.length && this.bytes > 0) {
      await this.callbacks.onFinal?.(DEMO_SCRIPT[this.nextIndex++]);
    }
    this.callbacks.onClose?.('Demo stream ended');
  }
}
