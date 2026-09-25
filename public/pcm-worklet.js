class Pcm16Worklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this.source = [];
    this.cursor = 0;
    this.output = [];
    this.ratio = sampleRate / 16_000;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel?.length) return true;
    for (const value of channel) this.source.push(value);

    while (this.cursor + 1 < this.source.length) {
      const left = Math.floor(this.cursor);
      const mix = this.cursor - left;
      const sample = this.source[left] * (1 - mix) + this.source[left + 1] * mix;
      this.output.push(Math.max(-1, Math.min(1, sample)));
      this.cursor += this.ratio;
      if (this.output.length === 1_600) {
        const pcm = new Int16Array(1_600);
        for (let index = 0; index < pcm.length; index += 1) {
          const value = this.output[index];
          pcm[index] = value < 0 ? value * 0x8000 : value * 0x7fff;
        }
        this.port.postMessage(pcm.buffer, [pcm.buffer]);
        this.output = [];
      }
    }

    const consumed = Math.floor(this.cursor);
    if (consumed > 0) {
      this.source.splice(0, consumed);
      this.cursor -= consumed;
    }
    return true;
  }
}

registerProcessor('pcm16-worklet', Pcm16Worklet);
