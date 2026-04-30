import { v7 as uuidv7 } from 'uuid';
import { sql } from 'kysely';
import { writeAudit } from '../../lib/audit.js';
import { unwrapDek, encrypt, decrypt } from '../../lib/crypto/envelope.js';
import { isStepped } from '../../lib/auth/session.js';
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
    });

    const a = baseAudit(ctx);
    await writeAudit(tx, {
      actorType: 'customer',
      actorId: customerUserId,
      action: 'credential.created',
      targetType: 'credential',
      targetId: id,
      metadata: { ...a.metadata, customerId, provider: p, label: l, createdBy: 'customer' },
      visibleToCustomer: true,
      ip: a.ip,
      userAgentHash: a.userAgentHash,
    });

    return { credentialId: id };
  });
}

async function lockOpenRequest(tx, requestId) {
  // FOR UPDATE on the request row serialises concurrent fulfilment
  // attempts on the same request — the second concurrent caller will
  // see status='fulfilled' on its post-lock re-check and bail.
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

export async function view(db, {
  adminId,
  sessionId,
  credentialId,
}, ctx = {}) {
  const kek = requireKek(ctx, 'credentials.view');

  // Step-up gate first — if it fails we MUST NOT touch the credential row
  // and MUST NOT write an audit (the trust contract is "every successful
  // view is audited"; failed step-up attempts are surfaced via the route's
  // own auth/login.failure stream, not here).
  if (!(await isStepped(db, sessionId))) {
    throw new StepUpRequiredError();
  }

  return await db.transaction().execute(async (tx) => {
    const cred = await repo.findCredentialById(tx, credentialId);
    if (!cred) throw new CredentialNotFoundError(credentialId);

    const customer = await loadCustomerDekRow(tx, cred.customer_id);
    const dek = unwrapDek({
      ciphertext: customer.dek_ciphertext,
      iv: customer.dek_iv,
      tag: customer.dek_tag,
    }, kek);
    const plaintext = decrypt({
      ciphertext: cred.payload_ciphertext,
      iv: cred.payload_iv,
      tag: cred.payload_tag,
    }, dek);
    const payload = JSON.parse(plaintext.toString('utf8'));

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

    return {
      credentialId,
      customerId: cred.customer_id,
      provider: cred.provider,
      label: cred.label,
      needsUpdate: cred.needs_update,
      payload,
    };
  });
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

function requireSomethingToChange(label, payload) {
  const labelGiven = label !== undefined && label !== null;
  const payloadGiven = payload !== undefined && payload !== null;
  if (!labelGiven && !payloadGiven) {
    throw new Error('updateCredential: nothing to change — supply label and/or payload');
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
}, ctx = {}) {
  const { label: labelTrimmed, payload: payloadGiven } = requireSomethingToChange(label, payload);
  const kek = payloadGiven !== null ? requireKek(ctx, 'credentials.updateByCustomer') : null;

  return await db.transaction().execute(async (tx) => {
    const cred = await repo.findCredentialById(tx, credentialId);
    if (!cred) throw new CredentialNotFoundError(credentialId);
    await assertCustomerUserBelongsTo(tx, customerUserId, cred.customer_id);

    let envPatch = {};
    if (payloadGiven !== null) {
      envPatch = await buildUpdatePayload({
        db: tx, customerId: cred.customer_id, payload: payloadGiven, kek,
      });
    }
    await repo.updateCredential(tx, credentialId, {
      label: labelTrimmed,
      ...envPatch,
    });

    const a = baseAudit(ctx);
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
      },
      visibleToCustomer: true,
      ip: a.ip,
      userAgentHash: a.userAgentHash,
    });

    return { credentialId };
  });
}

export async function updateByAdmin(db, {
  adminId,
  sessionId,
  credentialId,
  label,
  payload,
}, ctx = {}) {
  const { label: labelTrimmed, payload: payloadGiven } = requireSomethingToChange(label, payload);
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

    let envPatch = {};
    if (payloadGiven !== null) {
      envPatch = await buildUpdatePayload({
        db: tx, customerId: cred.customer_id, payload: payloadGiven, kek,
      });
    }
    await repo.updateCredential(tx, credentialId, {
      label: labelTrimmed,
      ...envPatch,
    });

    const a = baseAudit(ctx);
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
      },
      visibleToCustomer: true,
      ip: a.ip,
      userAgentHash: a.userAgentHash,
    });

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
