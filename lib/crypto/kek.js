import { readFileSync, statSync } from 'node:fs';

const REQUIRED_MODE = 0o400;
const REQUIRED_BYTES = 32;

export function loadKek(path) {
  const st = statSync(path);
  const mode = st.mode & 0o777;
  if (mode !== REQUIRED_MODE) {
    throw new Error(`KEK mode ${mode.toString(8).padStart(4, '0')} expected ${REQUIRED_MODE.toString(8).padStart(4, '0')}`);
  }
  const buf = readFileSync(path);
  if (buf.length !== REQUIRED_BYTES) {
    throw new Error(`KEK length ${buf.length} expected ${REQUIRED_BYTES} bytes`);
  }
  return buf;
}
