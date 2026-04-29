#!/usr/bin/env node
//
// create-admin.js — first-admin bootstrap.
//
// Refuses to run if any admin already exists; subsequent admins are
// created via the admin UI in M5+ or via service.requestPasswordReset
// from a SQL one-liner if you got here in an emergency.
//
// Prints the welcome URL to stdout because the email pipeline is not
// ready until M4. From M4 onwards, the same URL is also delivered by
// email; the stdout copy stays as a belt-and-braces escape hatch for
// the operator.
//
// Usage:
//   sudo -u portal-app /opt/dbstudio_portal/.node/bin/node scripts/create-admin.js
//   (interactive: prompts for email + name)

import readline from 'node:readline/promises';
import { stdin as input, stdout as output, exit } from 'node:process';
import { loadEnv } from '../config/env.js';
import { createDb } from '../config/db.js';
import { countAdmins } from '../domain/admins/repo.js';
import { create as createAdmin } from '../domain/admins/service.js';

async function prompt(rl, label, validate) {
  while (true) {
    const v = (await rl.question(label)).trim();
    if (validate(v)) return v;
    output.write('  invalid; try again.\n');
  }
}

async function main() {
  const env = loadEnv();
  const db = createDb({ connectionString: env.DATABASE_URL });

  try {
    const total = await countAdmins(db);
    if (total > 0) {
      output.write(`refusing to create another admin: ${total} already exist.\n`);
      output.write('use the admin UI (M5+), or service.requestPasswordReset, to recover an admin.\n');
      exit(1);
    }

    const rl = readline.createInterface({ input, output });
    const email = await prompt(rl, 'admin email: ', s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s));
    const name = await prompt(rl, 'admin display name: ', s => s.length >= 1);
    rl.close();

    const { id, inviteToken } = await createAdmin(
      db,
      { email, name },
      { actorType: 'system', ip: null, userAgentHash: null, audit: { reason: 'create-admin CLI' } },
    );

    const welcomeUrl = `${env.PORTAL_BASE_URL.replace(/\/+$/, '')}/welcome/${inviteToken}`;
    output.write('\n');
    output.write(`admin created: id=${id}\n`);
    output.write(`welcome url (valid for 7 days, single-use):\n  ${welcomeUrl}\n`);
    output.write('\n');
    output.write('open it in a browser to set the password and enrol 2FA.\n');
  } finally {
    await db.destroy();
  }
}

main().catch((err) => {
  output.write(`error: ${err.message}\n`);
  exit(1);
});
