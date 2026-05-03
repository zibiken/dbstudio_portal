// Shared helper used by project-phases.js + phase-checklist-items.js to
// content-negotiate the response format for phase mutations.
//
// When the request asks for a fragment (Accept: text/html-fragment or
// ?fragment=row), we render _phase-row.ejs for the affected phase and
// return only that <li>. Otherwise we redirect to the project detail
// page with #phase-<id> so the browser scrolls back to the row that
// was just edited.

import ejs from 'ejs';
import * as path from 'node:path';
import { listPhasesByProject } from '../../domain/phases/repo.js';
import { listItemsByPhase } from '../../domain/phase-checklists/repo.js';
import { findCustomerById } from '../../domain/customers/repo.js';
import { findProjectById } from '../../domain/projects/repo.js';

const VIEWS_DIR = path.resolve(process.cwd(), 'views');

export function wantsFragment(req) {
  const acc = String(req.headers['accept'] ?? '');
  if (acc.includes('text/html-fragment')) return true;
  if (typeof req.query?.fragment === 'string' && req.query.fragment === 'row') return true;
  return false;
}

export async function renderPhaseFragment(app, reply, { customerId, projectId, phaseId }) {
  const customer = await findCustomerById(app.db, customerId);
  const project = await findProjectById(app.db, projectId);
  if (!customer || !project) { reply.code(404); return reply.send(''); }
  const allPhases = await listPhasesByProject(app.db, project.id);
  const idx = allPhases.findIndex(p => p.id === phaseId);
  if (idx === -1) { reply.code(404); return reply.send(''); }
  const phase = allPhases[idx];
  const items = await listItemsByPhase(app.db, phase.id);
  const csrfToken = await reply.generateCsrf();
  const html = await ejs.renderFile(
    path.join(VIEWS_DIR, 'components', '_phase-row.ejs'),
    { phase: { ...phase, items }, idx, customer, project, csrfToken, phaseListLength: allPhases.length },
    { root: VIEWS_DIR },
  );
  reply.header('content-type', 'text/html; charset=utf-8');
  return reply.send(html);
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

export async function fragmentError(reply, message) {
  reply.code(422);
  reply.header('content-type', 'text/html; charset=utf-8');
  return reply.send(`<div class="alert alert--error" role="alert"><div class="alert__body">${escapeHtml(message)}</div></div>`);
}

export async function fragmentDeleted(reply, phaseId) {
  reply.header('content-type', 'text/html; charset=utf-8');
  return reply.send(`<div data-phase-deleted="${escapeHtml(phaseId)}"></div>`);
}
