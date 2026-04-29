import { sql } from 'kysely';

const COLUMN_MAP = {
  email: 'email',
  name: 'name',
  passwordHash: 'password_hash',
  inviteTokenHash: 'invite_token_hash',
  inviteExpiresAt: 'invite_expires_at',
  inviteConsumedAt: 'invite_consumed_at',
  totpSecretEnc: 'totp_secret_enc',
  totpIv: 'totp_iv',
  totpTag: 'totp_tag',
  webauthnCreds: 'webauthn_creds',
  emailOtpEnabled: 'email_otp_enabled',
  backupCodes: 'backup_codes',
  language: 'language',
};

export async function insertAdmin(db, {
  id, email, name,
  passwordHash = null,
  inviteTokenHash = null,
  inviteExpiresAt = null,
}) {
  await sql`
    INSERT INTO admins (id, email, name, password_hash, invite_token_hash, invite_expires_at)
    VALUES (
      ${id}::uuid,
      ${email},
      ${name},
      ${passwordHash},
      ${inviteTokenHash},
      ${inviteExpiresAt}
    )
  `.execute(db);
}

export async function findById(db, id) {
  const r = await sql`SELECT * FROM admins WHERE id = ${id}::uuid`.execute(db);
  return r.rows[0] ?? null;
}

export async function findByEmail(db, email) {
  const r = await sql`SELECT * FROM admins WHERE email = ${email}::citext`.execute(db);
  return r.rows[0] ?? null;
}

export async function countAdmins(db, { emailLike } = {}) {
  const r = emailLike
    ? await sql`SELECT count(*)::int AS c FROM admins WHERE email LIKE ${emailLike}`.execute(db)
    : await sql`SELECT count(*)::int AS c FROM admins`.execute(db);
  return r.rows[0].c;
}

export async function updateAdmin(db, id, fields) {
  const setParts = Object.entries(fields)
    .filter(([_k, v]) => v !== undefined)
    .map(([k, v]) => {
      const col = COLUMN_MAP[k];
      if (!col) throw new Error(`updateAdmin: unknown field '${k}'`);
      return sql`${sql.ref(col)} = ${v}`;
    });
  if (setParts.length === 0) return;
  await sql`UPDATE admins SET ${sql.join(setParts, sql`, `)} WHERE id = ${id}::uuid`.execute(db);
}
