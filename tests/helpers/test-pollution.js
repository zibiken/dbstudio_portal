import { sql } from 'kysely';

// Cleanup helper for test rows that survive customer/admin teardown via
// non-CASCADEd referential paths. The 2026-04-30 fixture leak proved the
// digest and outbox tables can outlive their fixture customer/admin rows
// and get processed by the live workers — this helper closes the gap.
//
// Inputs (all optional; helper is a no-op when none are given):
//   - recipientIds:    UUIDs of customer_users / admins whose digest rows
//                      and schedules should be deleted.
//   - emailAddresses:  exact to_address values to delete from email_outbox.
//   - e2eEmailPattern: if true, also delete email_outbox rows whose
//                      to_address matches '%_e2e@example.com' (defense-
//                      in-depth fallback for fixtures that didn't tag
//                      their emails into emailAddresses).
export async function pruneTestPollution(db, {
  recipientIds = [],
  emailAddresses = [],
  e2eEmailPattern = false,
} = {}) {
  if (recipientIds.length > 0) {
    await sql`
      DELETE FROM pending_digest_items
      WHERE recipient_id = ANY(${recipientIds}::uuid[])
    `.execute(db);
    await sql`
      DELETE FROM digest_schedules
      WHERE recipient_id = ANY(${recipientIds}::uuid[])
    `.execute(db);
  }
  if (emailAddresses.length > 0) {
    await sql`
      DELETE FROM email_outbox
      WHERE to_address = ANY(${emailAddresses}::text[])
    `.execute(db);
  }
  if (e2eEmailPattern) {
    await sql`
      DELETE FROM email_outbox
      WHERE to_address ILIKE ${'%\\_e2e@example.com'} ESCAPE '\\'
    `.execute(db);
  }
}
