import { v7 as uuidv7 } from 'uuid';
import { sql } from 'kysely';
import { writeAudit } from '../../lib/audit.js';
import { listActiveCustomerUsers, listActiveAdmins } from '../../lib/digest-fanout.js';
import { recordForDigest } from '../../lib/digest.js';
import { titleFor } from '../../lib/digest-strings.js';
import { unwrapDek, encrypt, decrypt } from '../../lib/crypto/envelope.js';
import { isStepped } from '../../lib/auth/session.js';
import { isVaultUnlocked, unlockVault } from '../../lib/auth/vault-lock.js';
import * as repo from './repo.js';

// Customer DEK envelope contract (spec §2.4): credential payloads are
// encrypted with the customer's DEK, never with the KEK directly. The DEK
// is unwrapped inside the request handler, used once, and falls out of
// scope when the function returns. It is never logged, never serialised,
// never persisted in plaintext.

export class CredentialNotFoundError extends Error {
  constructor(id) {
    super(`credential ${id} not found`);
    this.name = 'CredentialNotFoundError';
    this.code = 'CREDENTIAL_NOT_FOUND';
  }
}

export class CrossCustomerError extends Error {
  constructor() {
    super('cross-customer access refused');
    this.name = 'CrossCustomerError';
    this.code = 'CROSS_CUSTOMER';
  }
}

export class ProjectScopeError extends Error {
  constructor(projectId, customerId) {
    super(`project ${projectId} does not belong to customer ${customerId}`);
    this.name = 'ProjectScopeError';
    this.code = 'PROJECT_SCOPE';
  }
}

async function assertProjectBelongsToCustomer(tx, projectId, customerId) {
  if (projectId === null || projectId === undefined) return;
  // FOR UPDATE locks the project row for the rest of this transaction so a
  // concurrent UPDATE on projects.customer_id can't slip through between
  // this check and the credential INSERT/UPDATE that follows. The FK with
  // ON DELETE RESTRICT already prevents deletion races; this covers the
  // ownership-reassignment race DeepSeek flagged on G4 review.
  const r = await sql`
    SELECT 1 FROM projects
     WHERE id = ${projectId}::uuid AND customer_id = ${customerId}::uuid
       FOR UPDATE
  `.execute(tx);
  if (r.rows.length === 0) throw new ProjectScopeError(projectId, customerId);
}

export class CredentialRequestNotFoundError extends Error {
  constructor(id) {
    super(`credential_request ${id} not found`);
    this.name = 'CredentialRequestNotFoundError';
    this.code = 'CREDENTIAL_REQUEST_NOT_FOUND';
  }
}

export class CredentialRequestNotOpenError extends Error {
  constructor(status) {
    super(`credential_request is in status '${status}', expected 'open'`);
    this.name = 'CredentialRequestNotOpenError';
    this.code = 'CREDENTIAL_REQUEST_NOT_OPEN';
  }
}

export class StepUpRequiredError extends Error {
  constructor() {
    super('step-up authentication required to view this credential');
    this.name = 'StepUpRequiredError';
    this.code = 'STEP_UP_REQUIRED';
  }
}

export class DecryptFailureError extends Error {
  constructor(message = 'credential decrypt failed; corrupt ciphertext or DEK mismatch') {
    super(message);
    this.name = 'DecryptFailureError';
    this.code = 'DECRYPT_FAILURE';
    this.status = 500;
  }
}

function requireKek(ctx, callerName) {
  const kek = ctx?.kek;
  if (!Buffer.isBuffer(kek) || kek.length !== 32) {
    throw new Error(`${callerName} requires ctx.kek (32-byte Buffer)`);
  }
  return kek;
}

function requireProviderLabel(provider, label) {
  if (typeof provider !== 'string' || provider.trim() === '') {
    throw new Error('provider is required and must be a non-empty string');
  }
  if (typeof label !== 'string' || label.trim() === '') {
    throw new Error('label is required and must be a non-empty string');
  }
  return { provider: provider.trim(), label: label.trim() };
}

function encodePayload(payload) {
  if (
    payload === null
    || typeof payload !== 'object'
    || Array.isArray(payload)
  ) {
    throw new Error('credential payload must be a non-null, non-array object');
  }
  return Buffer.from(JSON.stringify(payload), 'utf8');
}

async function loadCustomerDekRow(db, customerId) {
  const r = await sql`
    SELECT id, status, dek_ciphertext, dek_iv, dek_tag
      FROM customers WHERE id = ${customerId}::uuid
  `.execute(db);
  if (r.rows.length === 0) {
    throw new Error(`customer ${customerId} not found`);
  }
  return r.rows[0];
}

async function assertCustomerUserBelongsTo(db, customerUserId, customerId) {
  const r = await sql`
    SELECT 1 FROM customer_users
     WHERE id = ${customerUserId}::uuid
       AND customer_id = ${customerId}::uuid
  `.execute(db);
  if (r.rows.length === 0) throw new CrossCustomerError();
}

function baseAudit(ctx) {
  return {
    metadata: { ...(ctx?.audit ?? {}) },
    ip: ctx?.ip ?? null,
    userAgentHash: ctx?.userAgentHash ?? null,
  };
}

export async function createByCustomer(db, {
  customerId,
  customerUserId,
  provider,
  label,
  payload,
  projectId = null,
}, ctx = {}) {
  const kek = requireKek(ctx, 'credentials.createByCustomer');
  const { provider: p, label: l } = requireProviderLabel(provider, label);
  const plaintext = encodePayload(payload);

  return await db.transaction().execute(async (tx) => {
    const customer = await loadCustomerDekRow(tx, customerId);
    if (customer.status !== 'active') {
      throw new Error(
        `cannot create credential for customer in status '${customer.status}' — must be 'active'`,
      );
    }
    await assertCustomerUserBelongsTo(tx, customerUserId, customerId);
    await assertProjectBelongsToCustomer(tx, projectId, customerId);

    const dek = unwrapDek({
      ciphertext: customer.dek_ciphertext,
      iv: customer.dek_iv,
      tag: customer.dek_tag,
    }, kek);
    const env = encrypt(plaintext, dek);

    const id = uuidv7();
    await repo.insertCredential(tx, {
      id,
      customerId,
      provider: p,
      label: l,
      payloadCiphertext: env.ciphertext,
      payloadIv: env.iv,
      payloadTag: env.tag,
      createdBy: 'customer',
      projectId,
    });

    const a = baseAudit(ctx);
    await writeAudit(tx, {
      actorType: 'customer',
      actorId: customerUserId,
      action: 'credential.created',
      targetType: 'credential',
      targetId: id,
      metadata: { ...a.metadata, customerId, projectId, provider: p, label: l, createdBy: 'customer' },
      visibleToCustomer: true,
      ip: a.ip,
      userAgentHash: a.userAgentHash,
    });

    // Phase B: admin FYI fan-out (coalescing — multiple customer-added
    // credentials in one digest window collapse into one line).
    const cnameRow = await sql`SELECT razon_social FROM customers WHERE id = ${customerId}::uuid`.execute(tx);
    const customerName = cnameRow.rows[0]?.razon_social ?? '';
    const admins = await listActiveAdmins(tx);
    for (const adm of admins) {
      const vars = { customerName, count: 1 };
      await recordForDigest(tx, {
        recipientType: 'admin',
        recipientId:   adm.id,
        customerId,
        bucket:        'fyi',
        eventType:     'credential.created',
        title:         titleFor('credential.created', adm.locale, vars),
        linkPath:      `/admin/customers/${customerId}/credentials`,
        metadata:      { credentialId: id, customerId },
        vars,
        locale:        adm.locale,
      });
    }

    return { credentialId: id };
  });
}

async function lockOpenRequest(tx, requestId) {
  // FOR UPDATE on the request row serialises concurrent fulfilment
  // attempts on the same request — the second concurrent caller will
  // see status='fulfilled' on its post-lock re-check and bail.
  // Note: credential_requests has NO project_id column in v1; admins
  // rescope the resulting credential after fulfilment via the show page.
  const r = await sql`
    SELECT id, customer_id, provider, status
      FROM credential_requests
     WHERE id = ${requestId}::uuid
       FOR UPDATE
  `.execute(tx);
  if (r.rows.length === 0) throw new CredentialRequestNotFoundError(requestId);
  const row = r.rows[0];
  if (row.status !== 'open') throw new CredentialRequestNotOpenError(row.status);
  return row;
}

export async function createByAdminFromRequest(db, {
  adminId,
  requestId,
  payload,
  label,
}, ctx = {}) {
  const kek = requireKek(ctx, 'credentials.createByAdminFromRequest');
  if (typeof label !== 'string' || label.trim() === '') {
    throw new Error('label is required and must be a non-empty string');
  }
  const labelTrimmed = label.trim();
  const plaintext = encodePayload(payload);

  return await db.transaction().execute(async (tx) => {
    const reqRow = await lockOpenRequest(tx, requestId);
    const customer = await loadCustomerDekRow(tx, reqRow.customer_id);
    if (customer.status !== 'active') {
      throw new Error(
        `cannot fulfil credential_request for customer in status '${customer.status}' — must be 'active'`,
      );
    }

    const dek = unwrapDek({
      ciphertext: customer.dek_ciphertext,
      iv: customer.dek_iv,
      tag: customer.dek_tag,
    }, kek);
    const env = encrypt(plaintext, dek);

    const credentialId = uuidv7();
    await repo.insertCredential(tx, {
      id: credentialId,
      customerId: reqRow.customer_id,
      provider: reqRow.provider,
      label: labelTrimmed,
      payloadCiphertext: env.ciphertext,
      payloadIv: env.iv,
      payloadTag: env.tag,
      createdBy: 'admin',
      // credential_requests has no project_id column — admin-fulfilled
      // credentials land company-wide and can be rescoped via the show page.
      projectId: null,
    });

    await sql`
      UPDATE credential_requests
         SET status = 'fulfilled',
             fulfilled_credential_id = ${credentialId}::uuid,
             updated_at = now()
       WHERE id = ${requestId}::uuid
    `.execute(tx);

    const a = baseAudit(ctx);
    await writeAudit(tx, {
      actorType: 'admin',
      actorId: adminId,
      action: 'credential.created',
      targetType: 'credential',
      targetId: credentialId,
      metadata: {
        ...a.metadata,
        customerId: reqRow.customer_id,
        projectId: null,
        provider: reqRow.provider,
        label: labelTrimmed,
        createdBy: 'admin',
        requestId,
      },
      visibleToCustomer: true,
      ip: a.ip,
      userAgentHash: a.userAgentHash,
    });
    await writeAudit(tx, {
      actorType: 'admin',
      actorId: adminId,
      action: 'credential_request.fulfilled',
      targetType: 'credential_request',
      targetId: requestId,
      metadata: {
        ...a.metadata,
        customerId: reqRow.customer_id,
        projectId: null,
        provider: reqRow.provider,
        credentialId,
      },
      visibleToCustomer: true,
      ip: a.ip,
      userAgentHash: a.userAgentHash,
    });

    return { credentialId, requestId };
  });
}

// Admin direct-add path (no credential_request needed). Mirrors
// createByAdminFromRequest minus the request lock + fulfilment update;
// audit + Phase B digest fan to customer_users keep the customer's
// Activity feed honest about admin-side mutations.
export async function createByAdmin(db, {
  adminId,
  customerId,
  provider,
  label,
  payload,
  projectId = null,
}, ctx = {}) {
  const kek = requireKek(ctx, 'credentials.createByAdmin');
  const { provider: p, label: l } = requireProviderLabel(provider, label);
  const plaintext = encodePayload(payload);

  return await db.transaction().execute(async (tx) => {
    const customer = await loadCustomerDekRow(tx, customerId);
    if (customer.status !== 'active') {
      throw new Error(
        `cannot create credential for customer in status '${customer.status}' — must be 'active'`,
      );
    }
    await assertProjectBelongsToCustomer(tx, projectId, customerId);

    const dek = unwrapDek({
      ciphertext: customer.dek_ciphertext,
      iv: customer.dek_iv,
      tag: customer.dek_tag,
    }, kek);
    const env = encrypt(plaintext, dek);

    const id = uuidv7();
    await repo.insertCredential(tx, {
      id,
      customerId,
      provider: p,
      label: l,
      payloadCiphertext: env.ciphertext,
      payloadIv: env.iv,
      payloadTag: env.tag,
      createdBy: 'admin',
      projectId,
    });

    const a = baseAudit(ctx);
    await writeAudit(tx, {
      actorType: 'admin',
      actorId: adminId,
      action: 'credential.created',
      targetType: 'credential',
      targetId: id,
      metadata: { ...a.metadata, customerId, projectId, provider: p, label: l, createdBy: 'admin' },
      visibleToCustomer: true,
      ip: a.ip,
      userAgentHash: a.userAgentHash,
    });

    const cnameRow = await sql`SELECT razon_social FROM customers WHERE id = ${customerId}::uuid`.execute(tx);
    const customerName = cnameRow.rows[0]?.razon_social ?? '';
    const customerUsers = await listActiveCustomerUsers(tx, customerId);
    for (const u of customerUsers) {
      const vars = { customerName, count: 1 };
      await recordForDigest(tx, {
        recipientType: 'customer_user',
        recipientId:   u.id,
        customerId,
        bucket:        'fyi',
        eventType:     'credential.created',
        title:         titleFor('credential.created', u.locale, vars),
        linkPath:      `/customer/credentials/${id}`,
        metadata:      { credentialId: id, customerId, createdBy: 'admin' },
        vars,
        locale:        u.locale,
      });
    }

    return { credentialId: id };
  });
}

// Note (M7 review M4 — admin view of suspended-customer credentials):
// `view` does NOT enforce customer.status='active'. This is intentional
// for the admin path: an operator may need to read a customer's
// credentials during forensic / dispute / off-boarding work even after
// the customer has been suspended or archived. The trust contract still
// holds — every view writes credential.viewed visible_to_customer=true,
// so on customer reactivation they see the access in their activity feed.
// The customer-side view path (M8 work) MUST add the active-status check;
// a suspended customer reading their own credentials is a different
// authorisation question.
export async function view(db, {
  adminId,
  sessionId,
  credentialId,
}, ctx = {}) {
  const kek = requireKek(ctx, 'credentials.view');

  // Vault-lock gate (Task 7.3) — the credential-vault sliding-idle flag
  // replaces the bare step-up gate for `view`. Step-up sets the flag,
  // every successful view refreshes it, 5 min of credential idleness
  // clears it. If we fail this gate we MUST NOT touch the credential
  // row, MUST NOT write an audit, and MUST NOT refresh the timer
  // (refreshing a locked vault would let a leaked sid keep itself alive
  // forever by hammering the route).
  if (!(await isVaultUnlocked(db, sessionId))) {
    throw new StepUpRequiredError();
  }

  // Decrypt-failure handling (M7 review I1 — mirrors M6's documents
  // file_integrity_failure). If unwrapDek/decrypt throws (corrupt
  // ciphertext, DEK mismatch, GCM auth-tag failure), we MUST:
  //   - NOT return plaintext (or anything that could be partial plaintext)
  //   - write an operator-forensic audit OUTSIDE the rolled-back tx
  //     (visible_to_customer=false; this is operator-side, not the
  //     trust-contract stream — the customer was never shown anything)
  //   - NOT refresh the vault-lock timer
  //   - throw a typed DecryptFailureError so the route returns 500
  //
  // The audit-write itself may fail (DB unreachable, statement timeout).
  // The throw happens unconditionally so corrupt bytes never reach the
  // client even if we couldn't record the forensic trail.
  try {
    return await db.transaction().execute(async (tx) => {
      const cred = await repo.findCredentialById(tx, credentialId);
      if (!cred) throw new CredentialNotFoundError(credentialId);

      const customer = await loadCustomerDekRow(tx, cred.customer_id);
      const dek = unwrapDek({
        ciphertext: customer.dek_ciphertext,
        iv: customer.dek_iv,
        tag: customer.dek_tag,
      }, kek);
      let plaintext;
      let payload;
      try {
        plaintext = decrypt({
          ciphertext: cred.payload_ciphertext,
          iv: cred.payload_iv,
          tag: cred.payload_tag,
        }, dek);
        payload = JSON.parse(plaintext.toString('utf8'));
      } catch (err) {
        // Re-thrown below outside the tx so the forensic audit doesn't
        // get rolled back with the failed decrypt.
        const dfe = new DecryptFailureError();
        dfe._forensic = { credentialId, customerId: cred.customer_id, provider: cred.provider, label: cred.label, cause: err.message };
        throw dfe;
      }

      const a = baseAudit(ctx);
      await writeAudit(tx, {
        actorType: 'admin',
        actorId: adminId,
        action: 'credential.viewed',
        targetType: 'credential',
        targetId: credentialId,
        metadata: {
          ...a.metadata,
          customerId: cred.customer_id,
          provider: cred.provider,
          label: cred.label,
        },
        visibleToCustomer: true,
        ip: a.ip,
        userAgentHash: a.userAgentHash,
      });

      // Phase B: customer FYI fan-out (coalescing — admin browsing N
      // credentials in one digest window collapses into one line).
      // Trust contract: every admin view is surfaced to the customer.
      const recipients = await listActiveCustomerUsers(tx, cred.customer_id);
      for (const u of recipients) {
        const vars = { recipient: 'customer', count: 1 };
        await recordForDigest(tx, {
          recipientType: 'customer_user',
          recipientId:   u.id,
          customerId:    cred.customer_id,
          bucket:        'fyi',
          eventType:     'credential.viewed',
          title:         titleFor('credential.viewed', u.locale, vars),
          linkPath:      '/customer/credentials',
          metadata:      { credentialId, provider: cred.provider, label: cred.label },
          vars,
          locale:        u.locale,
        });
      }

      // Slide the vault-lock window forward inside the same tx. If anything
      // above this point throws, the timer is left untouched (rollback).
      await unlockVault(tx, sessionId);

      return {
        credentialId,
        customerId: cred.customer_id,
        provider: cred.provider,
        label: cred.label,
        needsUpdate: cred.needs_update,
        payload,
      };
    });
  } catch (err) {
    if (err instanceof DecryptFailureError && err._forensic) {
      const a = baseAudit(ctx);
      try {
        await writeAudit(db, {
          actorType: 'admin',
          actorId: adminId,
          action: 'credential.decrypt_failure',
          targetType: 'credential',
          targetId: credentialId,
          metadata: {
            ...a.metadata,
            customerId: err._forensic.customerId,
            provider: err._forensic.provider,
            label: err._forensic.label,
            cause: err._forensic.cause,
          },
          visibleToCustomer: false,
          ip: a.ip,
          userAgentHash: a.userAgentHash,
        });
      } catch (auditErr) {
        if (typeof ctx?.log?.error === 'function') {
          ctx.log.error({ err: auditErr, credentialId },
            'failed to write credential.decrypt_failure audit; throwing DecryptFailureError unconditionally');
        }
      }
      // Strip the internal forensic payload before propagating.
      delete err._forensic;
    }
    throw err;
  }
}

// Phase F: customer-actor mirror of `view`. The customer reads their own
// stored secret with re-2FA gating (vault-lock identical to admin path).
// Audit row is actor_type='customer'/visible_to_customer=true; Phase B
// fan-out goes to ADMINS (not the customer; they did the action). Same
// DEK-unwrap path; same DecryptFailureError forensic-audit handling.
export async function viewByCustomer(db, {
  customerUserId,
  sessionId,
  credentialId,
}, ctx = {}) {
  const kek = requireKek(ctx, 'credentials.viewByCustomer');

  if (!(await isVaultUnlocked(db, sessionId))) {
    throw new StepUpRequiredError();
  }

  try {
    return await db.transaction().execute(async (tx) => {
      const cred = await repo.findCredentialById(tx, credentialId);
      if (!cred) throw new CredentialNotFoundError(credentialId);

      // Cross-customer guard: the customer_user must own the customer.
      await assertCustomerUserBelongsTo(tx, customerUserId, cred.customer_id);

      const customer = await loadCustomerDekRow(tx, cred.customer_id);
      if (customer.status !== 'active') {
        throw new Error(
          `cannot view credential for customer in status '${customer.status}' — must be 'active'`,
        );
      }
      const dek = unwrapDek({
        ciphertext: customer.dek_ciphertext,
        iv: customer.dek_iv,
        tag: customer.dek_tag,
      }, kek);

      let plaintext, payload;
      try {
        plaintext = decrypt({
          ciphertext: cred.payload_ciphertext,
          iv: cred.payload_iv,
          tag: cred.payload_tag,
        }, dek);
        payload = JSON.parse(plaintext.toString('utf8'));
      } catch (err) {
        const dfe = new DecryptFailureError();
        dfe._forensic = {
          credentialId,
          customerId: cred.customer_id,
          provider: cred.provider,
          label: cred.label,
          cause: err.message,
        };
        throw dfe;
      }

      const a = baseAudit(ctx);
      await writeAudit(tx, {
        actorType: 'customer',
        actorId: customerUserId,
        action: 'credential.viewed',
        targetType: 'credential',
        targetId: credentialId,
        metadata: {
          ...a.metadata,
          customerId: cred.customer_id,
          provider: cred.provider,
          label: cred.label,
        },
        visibleToCustomer: true,
        ip: a.ip,
        userAgentHash: a.userAgentHash,
      });

      // Phase B fan-out: customer-actor view notifies admins (not the
      // customer themselves — they performed the action).
      const cnameRow = await sql`
        SELECT razon_social FROM customers WHERE id = ${cred.customer_id}::uuid
      `.execute(tx);
      const customerName = cnameRow.rows[0]?.razon_social ?? '';
      const admins = await listActiveAdmins(tx);
      for (const adm of admins) {
        const vars = { recipient: 'admin', customerName, count: 1 };
        await recordForDigest(tx, {
          recipientType: 'admin',
          recipientId:   adm.id,
          customerId:    cred.customer_id,
          bucket:        'fyi',
          eventType:     'credential.viewed',
          title:         titleFor('credential.viewed', adm.locale, vars),
          linkPath:      `/admin/customers/${cred.customer_id}/credentials`,
          metadata:      { credentialId, provider: cred.provider, label: cred.label },
          vars,
          locale:        adm.locale,
        });
      }

      await unlockVault(tx, sessionId);

      return {
        credentialId,
        customerId: cred.customer_id,
        provider: cred.provider,
        label: cred.label,
        needsUpdate: cred.needs_update,
        payload,
      };
    });
  } catch (err) {
    if (err instanceof DecryptFailureError && err._forensic) {
      const a = baseAudit(ctx);
      try {
        await writeAudit(db, {
          actorType: 'customer',
          actorId: customerUserId,
          action: 'credential.decrypt_failure',
          targetType: 'credential',
          targetId: credentialId,
          metadata: {
            ...a.metadata,
            customerId: err._forensic.customerId,
            provider: err._forensic.provider,
            label: err._forensic.label,
            cause: err._forensic.cause,
          },
          visibleToCustomer: false,
          ip: a.ip,
          userAgentHash: a.userAgentHash,
        });
      } catch (auditErr) {
        if (typeof ctx?.log?.error === 'function') {
          ctx.log.error({ err: auditErr, credentialId },
            'failed to write credential.decrypt_failure (customer) audit');
        }
      }
      delete err._forensic;
    }
    throw err;
  }
}

export async function markNeedsUpdate(db, {
  adminId,
  credentialId,
}, ctx = {}) {
  return await db.transaction().execute(async (tx) => {
    const row = await repo.findCredentialById(tx, credentialId);
    if (!row) throw new CredentialNotFoundError(credentialId);
    await repo.markCredentialNeedsUpdate(tx, credentialId);

    const a = baseAudit(ctx);
    await writeAudit(tx, {
      actorType: 'admin',
      actorId: adminId,
      action: 'credential.needs_update_marked',
      targetType: 'credential',
      targetId: credentialId,
      metadata: {
        ...a.metadata,
        customerId: row.customer_id,
        provider: row.provider,
        label: row.label,
      },
      visibleToCustomer: true,
      ip: a.ip,
      userAgentHash: a.userAgentHash,
    });

    return { credentialId };
  });
}

async function buildUpdatePayload({ db, customerId, payload, kek }) {
  const customer = await loadCustomerDekRow(db, customerId);
  const dek = unwrapDek({
    ciphertext: customer.dek_ciphertext,
    iv: customer.dek_iv,
    tag: customer.dek_tag,
  }, kek);
  const env = encrypt(encodePayload(payload), dek);
  return {
    payloadCiphertext: env.ciphertext,
    payloadIv: env.iv,
    payloadTag: env.tag,
  };
}

function requireSomethingToChange(label, payload, projectIdGiven = false) {
  const labelGiven = label !== undefined && label !== null;
  const payloadGiven = payload !== undefined && payload !== null;
  if (!labelGiven && !payloadGiven && !projectIdGiven) {
    throw new Error('updateCredential: nothing to change — supply label, payload, and/or projectId');
  }
  if (labelGiven && (typeof label !== 'string' || label.trim() === '')) {
    throw new Error('label must be a non-empty string');
  }
  return {
    label: labelGiven ? label.trim() : null,
    payload: payloadGiven ? payload : null,
  };
}

export async function updateByCustomer(db, {
  customerUserId,
  credentialId,
  label,
  payload,
  projectId,
}, ctx = {}) {
  const projectIdProvided = projectId !== undefined;
  const { label: labelTrimmed, payload: payloadGiven } = requireSomethingToChange(label, payload, projectIdProvided);
  const kek = payloadGiven !== null ? requireKek(ctx, 'credentials.updateByCustomer') : null;

  return await db.transaction().execute(async (tx) => {
    const cred = await repo.findCredentialById(tx, credentialId);
    if (!cred) throw new CredentialNotFoundError(credentialId);
    await assertCustomerUserBelongsTo(tx, customerUserId, cred.customer_id);

    if (projectIdProvided) {
      await assertProjectBelongsToCustomer(tx, projectId, cred.customer_id);
    }

    let envPatch = {};
    if (payloadGiven !== null) {
      envPatch = await buildUpdatePayload({
        db: tx, customerId: cred.customer_id, payload: payloadGiven, kek,
      });
    }
    await repo.updateCredential(tx, credentialId, {
      label: labelTrimmed,
      ...envPatch,
      projectId: projectIdProvided ? projectId : null,
      projectIdProvided,
    });

    const a = baseAudit(ctx);
    const projectChanged = projectIdProvided && (cred.project_id ?? null) !== (projectId ?? null);
    await writeAudit(tx, {
      actorType: 'customer',
      actorId: customerUserId,
      action: 'credential.updated',
      targetType: 'credential',
      targetId: credentialId,
      metadata: {
        ...a.metadata,
        customerId: cred.customer_id,
        provider: cred.provider,
        label: labelTrimmed ?? cred.label,
        previousLabel: cred.label,
        payloadChanged: payloadGiven !== null,
        projectId: projectIdProvided ? projectId : (cred.project_id ?? null),
        previousProjectId: cred.project_id ?? null,
        projectChanged,
      },
      visibleToCustomer: true,
      ip: a.ip,
      userAgentHash: a.userAgentHash,
    });
    if (projectChanged) {
      await writeAudit(tx, {
        actorType: 'customer',
        actorId: customerUserId,
        action: 'credential.project_changed',
        targetType: 'credential',
        targetId: credentialId,
        metadata: {
          ...a.metadata,
          customerId: cred.customer_id,
          provider: cred.provider,
          label: labelTrimmed ?? cred.label,
          fromProjectId: cred.project_id ?? null,
          toProjectId: projectId ?? null,
        },
        visibleToCustomer: true,
        ip: a.ip,
        userAgentHash: a.userAgentHash,
      });
    }

    return { credentialId };
  });
}

export async function updateByAdmin(db, {
  adminId,
  sessionId,
  credentialId,
  label,
  payload,
  projectId,
}, ctx = {}) {
  const projectIdProvided = projectId !== undefined;
  const { label: labelTrimmed, payload: payloadGiven } = requireSomethingToChange(label, payload, projectIdProvided);
  const kek = payloadGiven !== null ? requireKek(ctx, 'credentials.updateByAdmin') : null;

  // Step-up gate: admin overwrites of customer credentials are sensitive
  // enough that we want a recent 2FA confirmation in the session, even
  // though no plaintext is exposed. Defence in depth: a leaked sid alone
  // does not let an attacker rotate customer credentials.
  if (!(await isStepped(db, sessionId))) {
    throw new StepUpRequiredError();
  }

  return await db.transaction().execute(async (tx) => {
    const cred = await repo.findCredentialById(tx, credentialId);
    if (!cred) throw new CredentialNotFoundError(credentialId);

    if (projectIdProvided) {
      await assertProjectBelongsToCustomer(tx, projectId, cred.customer_id);
    }

    let envPatch = {};
    if (payloadGiven !== null) {
      envPatch = await buildUpdatePayload({
        db: tx, customerId: cred.customer_id, payload: payloadGiven, kek,
      });
    }
    await repo.updateCredential(tx, credentialId, {
      label: labelTrimmed,
      ...envPatch,
      projectId: projectIdProvided ? projectId : null,
      projectIdProvided,
    });

    const a = baseAudit(ctx);
    const projectChanged = projectIdProvided && (cred.project_id ?? null) !== (projectId ?? null);
    await writeAudit(tx, {
      actorType: 'admin',
      actorId: adminId,
      action: 'credential.updated',
      targetType: 'credential',
      targetId: credentialId,
      metadata: {
        ...a.metadata,
        customerId: cred.customer_id,
        provider: cred.provider,
        label: labelTrimmed ?? cred.label,
        previousLabel: cred.label,
        payloadChanged: payloadGiven !== null,
        projectId: projectIdProvided ? projectId : (cred.project_id ?? null),
        previousProjectId: cred.project_id ?? null,
        projectChanged,
      },
      visibleToCustomer: true,
      ip: a.ip,
      userAgentHash: a.userAgentHash,
    });
    if (projectChanged) {
      await writeAudit(tx, {
        actorType: 'admin',
        actorId: adminId,
        action: 'credential.project_changed',
        targetType: 'credential',
        targetId: credentialId,
        metadata: {
          ...a.metadata,
          customerId: cred.customer_id,
          provider: cred.provider,
          label: labelTrimmed ?? cred.label,
          fromProjectId: cred.project_id ?? null,
          toProjectId: projectId ?? null,
        },
        visibleToCustomer: true,
        ip: a.ip,
        userAgentHash: a.userAgentHash,
      });
    }

    return { credentialId };
  });
}

export async function deleteByAdmin(db, {
  adminId,
  credentialId,
}, ctx = {}) {
  return await db.transaction().execute(async (tx) => {
    const row = await repo.findCredentialById(tx, credentialId);
    if (!row) throw new CredentialNotFoundError(credentialId);
    await repo.deleteCredentialById(tx, credentialId);

    const a = baseAudit(ctx);
    await writeAudit(tx, {
      actorType: 'admin',
      actorId: adminId,
      action: 'credential.deleted',
      targetType: 'credential',
      targetId: credentialId,
      metadata: {
        ...a.metadata,
        customerId: row.customer_id,
        provider: row.provider,
        label: row.label,
      },
      visibleToCustomer: true,
      ip: a.ip,
      userAgentHash: a.userAgentHash,
    });

    // Phase B digest fan-out to customer_users — admin-side deletes show
    // up in the customer's Activity feed so the trust model holds.
    const cnameRow = await sql`SELECT razon_social FROM customers WHERE id = ${row.customer_id}::uuid`.execute(tx);
    const customerName = cnameRow.rows[0]?.razon_social ?? '';
    const customerUsers = await listActiveCustomerUsers(tx, row.customer_id);
    for (const u of customerUsers) {
      const vars = { customerName, count: 1 };
      await recordForDigest(tx, {
        recipientType: 'customer_user',
        recipientId:   u.id,
        customerId:    row.customer_id,
        bucket:        'fyi',
        eventType:     'credential.deleted',
        title:         titleFor('credential.deleted', u.locale, vars),
        linkPath:      `/customer/credentials`,
        metadata:      { credentialId, customerId: row.customer_id, deletedBy: 'admin' },
        vars,
        locale:        u.locale,
      });
    }

    return { credentialId };
  });
}

export async function deleteByCustomer(db, {
  customerUserId,
  credentialId,
}, ctx = {}) {
  return await db.transaction().execute(async (tx) => {
    const row = await repo.findCredentialById(tx, credentialId);
    if (!row) throw new CredentialNotFoundError(credentialId);
    await assertCustomerUserBelongsTo(tx, customerUserId, row.customer_id);

    await repo.deleteCredentialById(tx, credentialId);

    const a = baseAudit(ctx);
    await writeAudit(tx, {
      actorType: 'customer',
      actorId: customerUserId,
      action: 'credential.deleted',
      targetType: 'credential',
      targetId: credentialId,
      metadata: {
        ...a.metadata,
        customerId: row.customer_id,
        provider: row.provider,
        label: row.label,
      },
      visibleToCustomer: true,
      ip: a.ip,
      userAgentHash: a.userAgentHash,
    });

    return { credentialId };
  });
}
