/** 固定四字节大端长度头的增量解码器错误，不包含任何对端正文。 */
export class LengthPrefixedFrameDecoderError extends Error {
  constructor() {
    super("长度前缀帧无效");
    this.name = "LengthPrefixedFrameDecoderError";
  }
}

/**
 * 每次只保留四字节长度头和一个已验证长度的正文。输入 chunk 即使包含许多
 * 帧或异常巨大，也不会再被整体拼接到第二个同等大小的缓冲区。
 */
export class LengthPrefixedFrameDecoder {
  private readonly maxFrameBytes: number;
  private readonly header = new Uint8Array(4);
  private headerBytes = 0;
  private body: Uint8Array | undefined;
  private bodyBytes = 0;

  constructor(maxFrameBytes: number) {
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes <= 0) {
      throw new TypeError("帧长度边界无效");
    }
    this.maxFrameBytes = maxFrameBytes;
  }

  push(bytes: Uint8Array, onFrame: (frame: Uint8Array) => boolean | void): void {
    let offset = 0;
    while (offset < bytes.byteLength) {
      if (this.body === undefined) {
        const headerCount = Math.min(4 - this.headerBytes, bytes.byteLength - offset);
        this.header.set(bytes.subarray(offset, offset + headerCount), this.headerBytes);
        this.headerBytes += headerCount;
        offset += headerCount;
        if (this.headerBytes < 4) return;

        const length = new DataView(this.header.buffer).getUint32(0, false);
        this.headerBytes = 0;
        if (length > this.maxFrameBytes) {
          this.reset();
          throw new LengthPrefixedFrameDecoderError();
        }
        this.body = new Uint8Array(length);
        this.bodyBytes = 0;
        if (length === 0 && !this.finishFrame(onFrame)) return;
      }

      const body = this.body;
      if (body === undefined) continue;
      const bodyCount = Math.min(body.byteLength - this.bodyBytes, bytes.byteLength - offset);
      body.set(bytes.subarray(offset, offset + bodyCount), this.bodyBytes);
      this.bodyBytes += bodyCount;
      offset += bodyCount;
      if (this.bodyBytes === body.byteLength && !this.finishFrame(onFrame)) return;
    }
  }

  hasPendingBytes(): boolean {
    return this.headerBytes !== 0 || this.body !== undefined;
  }

  reset(): void {
    this.headerBytes = 0;
    this.body = undefined;
    this.bodyBytes = 0;
  }

  private finishFrame(onFrame: (frame: Uint8Array) => boolean | void): boolean {
    const frame = this.body;
    if (frame === undefined) return true;
    this.body = undefined;
    this.bodyBytes = 0;
    if (onFrame(frame) === false) {
      this.reset();
      return false;
    }
    return true;
  }
}
