import { describe, it, expect, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

const REPO_DIR = '/opt/dbstudio_portal';
const SCRIPT = path.join(REPO_DIR, 'scripts/bootstrap-templates.sh');
const SRC_TEMPLATE = path.join(REPO_DIR, 'templates/nda.html');

function runBootstrap(overrides = {}) {
  const env = {
    ...process.env,
    REPO_DIR,
    APP_USER: os.userInfo().username,
    APP_GROUP: os.userInfo().username,
    SKIP_FONT_CHECK: '1',
    ...overrides,
  };
  return execFileSync('bash', [SCRIPT], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

describe('scripts/bootstrap-templates.sh', () => {
  let work;
  let templatesDir;
  let fontsDir;
  let dst;
  let fontLatin;
  let fontLatinExt;

  beforeEach(async () => {
    work = await fsp.mkdtemp(path.join(os.tmpdir(), 'nda-bootstrap-'));
    templatesDir = path.join(work, 'templates');
    fontsDir = path.join(work, 'fonts');
    await fsp.mkdir(templatesDir);
    await fsp.mkdir(fontsDir);
    dst = path.join(templatesDir, 'nda.html');
    fontLatin = path.join(fontsDir, 'cormorant-garamond-500.woff2');
    fontLatinExt = path.join(fontsDir, 'cormorant-garamond-500-latin-ext.woff2');
  });

  it('writes /var/lib/portal/templates/nda.html with @font-face and no remote @import', () => {
    runBootstrap({ TEMPLATES_DIR: templatesDir, FONTS_DIR: fontsDir });
    const out = fs.readFileSync(dst, 'utf8');

    expect(out).toContain('@font-face');
    expect(out).not.toMatch(/@import\s+url\([^)]*https?:\/\//);
    expect(out).not.toContain('fonts.googleapis.com');
    expect(out).not.toContain('fonts.gstatic.com');
    // Both unicode-range subsets should be inlined, mirroring the way
    // Google Fonts splits Cormorant Garamond.
    expect(out).toContain(`file://${fontLatin}`);
    expect(out).toContain(`file://${fontLatinExt}`);
    // Two @font-face blocks total (one per subset).
    expect((out.match(/@font-face/g) || []).length).toBe(2);
    expect(out).toContain("font-family: 'Cormorant Garamond'");
    expect(out).toMatch(/font-weight:\s*500/);
    // unicode-range markers from Google's split: U+0000-00FF (latin) and
    // U+0100-02BA (latin-ext) anchor the two blocks.
    expect(out).toContain('U+0000-00FF');
    expect(out).toContain('U+0100-02BA');
  });

  it('preserves the two data-yousign-anchor attributes', () => {
    runBootstrap({ TEMPLATES_DIR: templatesDir, FONTS_DIR: fontsDir });
    const out = fs.readFileSync(dst, 'utf8');
    expect(out).toContain('data-yousign-anchor="provider"');
    expect(out).toContain('data-yousign-anchor="client"');
  });

  it('preserves every Mustache placeholder verbatim', () => {
    runBootstrap({ TEMPLATES_DIR: templatesDir, FONTS_DIR: fontsDir });
    const out = fs.readFileSync(dst, 'utf8');
    for (const ph of [
      '{{CLIENTE_RAZON_SOCIAL}}',
      '{{CLIENTE_CIF}}',
      '{{CLIENTE_DOMICILIO}}',
      '{{CLIENTE_REPRESENTANTE_NOMBRE}}',
      '{{CLIENTE_REPRESENTANTE_DNI}}',
      '{{CLIENTE_REPRESENTANTE_CARGO}}',
      '{{OBJETO_PROYECTO}}',
      '{{FECHA_FIRMA}}',
      '{{LUGAR_FIRMA}}',
    ]) {
      expect(out).toContain(ph);
    }
  });

  it('refuses to install if the font is missing (default check)', () => {
    expect(() => execFileSync('bash', [SCRIPT], {
      env: {
        ...process.env, REPO_DIR,
        TEMPLATES_DIR: templatesDir,
        FONTS_DIR: fontsDir,
        APP_USER: os.userInfo().username, APP_GROUP: os.userInfo().username,
        // SKIP_FONT_CHECK NOT set → must fail
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })).toThrowError();
    expect(fs.existsSync(dst)).toBe(false);
  });

  it('refuses to install if only one of the two fonts is present', () => {
    fs.writeFileSync(fontLatin, 'fake');
    // fontLatinExt deliberately absent
    expect(() => execFileSync('bash', [SCRIPT], {
      env: {
        ...process.env, REPO_DIR,
        TEMPLATES_DIR: templatesDir,
        FONTS_DIR: fontsDir,
        APP_USER: os.userInfo().username, APP_GROUP: os.userInfo().username,
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })).toThrowError();
    expect(fs.existsSync(dst)).toBe(false);
  });

  it('passes the font check when both files exist', () => {
    fs.writeFileSync(fontLatin, 'fake-woff2');
    fs.writeFileSync(fontLatinExt, 'fake-woff2');
    runBootstrap({
      TEMPLATES_DIR: templatesDir,
      FONTS_DIR: fontsDir,
      SKIP_FONT_CHECK: '0',
    });
    expect(fs.existsSync(dst)).toBe(true);
  });

  it('is idempotent — re-running overwrites cleanly', () => {
    runBootstrap({ TEMPLATES_DIR: templatesDir, FONTS_DIR: fontsDir });
    const first = fs.readFileSync(dst, 'utf8');
    runBootstrap({ TEMPLATES_DIR: templatesDir, FONTS_DIR: fontsDir });
    const second = fs.readFileSync(dst, 'utf8');
    expect(second).toBe(first);
  });

  it('source template in the repo still has the legal-text body intact (verbatim contract)', () => {
    // The legal text is operator-supplied verbatim. This guards against an
    // accidental edit to templates/nda.html that would change the rendered
    // template_version_sha and silently invalidate every prior NDA's
    // sha-on-record. The source must keep both Mustache placeholders AND
    // the original Spanish title.
    const src = fs.readFileSync(SRC_TEMPLATE, 'utf8');
    expect(src).toContain('Acuerdo de Confidencialidad Mutuo y Protección de Datos');
    expect(src).toContain('{{CLIENTE_RAZON_SOCIAL}}');
    expect(src).toContain('{{OBJETO_PROYECTO}}');
  });
});
