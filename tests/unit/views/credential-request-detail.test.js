import { describe, it, expect } from 'vitest';
import ejs from 'ejs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const viewsRoot = path.resolve(__dirname, '../../../views');

describe('customer/credential-requests/detail.ejs', () => {
  it('renders without throwing when `form` local is undefined (the fulfil-page bug)', async () => {
    const tpl = path.join(viewsRoot, 'customer/credential-requests/detail.ejs');
    const html = await ejs.renderFile(tpl, {
      request: {
        id: '00000000-0000-0000-0000-000000000000',
        provider: 'Acme',
        status: 'open',
        created_at: new Date(),
        updated_at: new Date(),
        fields: [
          { name: 'username', label: 'Username', type: 'text', required: true },
          { name: 'apikey',   label: 'API key',  type: 'secret', required: true },
        ],
      },
      csrfToken: 'tok',
      euDateTime: (d) => String(d),
    }, { root: viewsRoot, async: true });
    expect(html).toContain('Provide credentials');
    expect(html).toContain('name="field__username"');
    expect(html).toContain('name="field__apikey"');
  });

  it('round-trips form values when the local IS provided (the 422-rerender path)', async () => {
    const tpl = path.join(viewsRoot, 'customer/credential-requests/detail.ejs');
    const html = await ejs.renderFile(tpl, {
      request: {
        id: '00000000-0000-0000-0000-000000000000',
        provider: 'Acme',
        status: 'open',
        created_at: new Date(),
        updated_at: new Date(),
        fields: [{ name: 'username', label: 'Username', type: 'text', required: true }],
      },
      csrfToken: 'tok',
      euDateTime: (d) => String(d),
      form: { label: 'My Acme', payload: { username: 'alice' } },
    }, { root: viewsRoot, async: true });
    expect(html).toContain('value="My Acme"');
    expect(html).toContain('value="alice"');
  });
});
