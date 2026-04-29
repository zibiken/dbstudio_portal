import * as path from 'node:path';
import * as url from 'node:url';
import { buildEmailTemplates } from '../scripts/email-build.js';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const srcDir = path.resolve(here, '..', 'emails');
const outFile = path.join(srcDir, '_compiled.js');

export async function setup() {
  await buildEmailTemplates({ srcDir, outFile });
}
