const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

export function isUtf8Buffer(value: Uint8Array): boolean {
  try {
    utf8Decoder.decode(value);
    return true;
  } catch {
    return false;
  }
}
