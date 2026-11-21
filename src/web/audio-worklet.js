function clampToPcm16(sample) {
  const clamped = Math.max(-1, Math.min(1, sample));
  return clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
}

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pendingSamples = [];
    this.frameSampleCount = Math.max(1, Math.round(sampleRate * 0.02));
  }

  flushFrame() {
    if (this.pendingSamples.length < this.frameSampleCount) {
      return;
    }

    const frame = new Int16Array(this.frameSampleCount);
    for (let index = 0; index < this.frameSampleCount; index += 1) {
      frame[index] = this.pendingSamples[index];
    }
    this.pendingSamples = this.pendingSamples.slice(this.frameSampleCount);

    this.port.postMessage(
      {
        type: "capture",
        sampleRate,
        frameSamples: this.frameSampleCount,
        buffer: frame.buffer,
      },
      [frame.buffer],
    );
  }

  process(inputs) {
    const input = inputs[0];
    const channel = input && input[0];

    if (!channel || channel.length === 0) {
      return true;
    }

    for (let index = 0; index < channel.length; index += 1) {
      this.pendingSamples.push(clampToPcm16(channel[index]));
    }

    while (this.pendingSamples.length >= this.frameSampleCount) {
      this.flushFrame();
    }

    return true;
  }
}

class PcmPlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.currentChunk = null;
    this.currentOffset = 0;
    this.hadBufferedAudio = false;
    this.drainNotified = false;
    this.playbackStartedNotified = false;
    this.port.onmessage = (event) => {
      const data = event.data;
      if (!data || typeof data !== "object") {
        return;
      }

      if (data.type === "clear") {
        this.queue = [];
        this.currentChunk = null;
        this.currentOffset = 0;
        this.hadBufferedAudio = false;
        this.drainNotified = false;
        this.playbackStartedNotified = false;
        return;
      }

      if (data.type !== "enqueue" || !(data.buffer instanceof ArrayBuffer)) {
        return;
      }

      this.queue.push(new Float32Array(data.buffer));
      this.hadBufferedAudio = true;
      this.drainNotified = false;
    };
  }

  getNextSample() {
    while (true) {
      if (!this.currentChunk || this.currentOffset >= this.currentChunk.length) {
        this.currentChunk = this.queue.shift() ?? null;
        this.currentOffset = 0;
      }

      if (!this.currentChunk) {
        return 0;
      }

      if (this.currentOffset < this.currentChunk.length) {
        if (!this.playbackStartedNotified) {
          this.playbackStartedNotified = true;
          this.port.postMessage({ type: "playback_started" });
        }
        const sample = this.currentChunk[this.currentOffset];
        this.currentOffset += 1;
        return sample ?? 0;
      }
    }
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const channel = output && output[0];

    if (!channel) {
      return true;
    }

    for (let index = 0; index < channel.length; index += 1) {
      channel[index] = this.getNextSample();
    }

    if (
      this.hadBufferedAudio &&
      !this.drainNotified &&
      !this.currentChunk &&
      this.queue.length === 0 &&
      channel.every((sample) => sample === 0)
    ) {
      this.drainNotified = true;
      this.playbackStartedNotified = false;
      this.port.postMessage({ type: "drained" });
    }

    return true;
  }
}

registerProcessor("pcm-capture-processor", PcmCaptureProcessor);
registerProcessor("pcm-playback-processor", PcmPlaybackProcessor);
