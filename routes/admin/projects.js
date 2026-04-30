import { renderAdmin } from '../../lib/render.js';
import { requireAdminSession } from '../../lib/auth/middleware.js';
import * as projectsService from '../../domain/projects/service.js';
import {
  findProjectById,
  listProjectsByCustomer,
} from '../../domain/projects/repo.js';
import { findCustomerById } from '../../domain/customers/repo.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function notFound(req, reply) {
  reply.code(404);
  return renderAdmin(req, reply, 'admin/customers/not-found', {
    title: 'Not found',
    activeNav: 'customers',
    mainWidth: 'content',
    sectionLabel: 'ADMIN · CUSTOMERS',
  });
}

function customerChrome(customer, activeTab) {
  return {
    activeNav: 'customers',
    sectionLabel: 'ADMIN · CUSTOMERS · ' + customer.razon_social.toUpperCase(),
    activeTab,
  };
}

function makeCtx(req, session) {
  return {
    actorType: 'admin',
    actorId: session.user_id,
    ip: req.ip ?? null,
    userAgentHash: null,
    audit: {},
  };
}

export function registerAdminProjectsRoutes(app) {
  app.get('/admin/customers/:cid/projects', async (req, reply) => {
    const session = await requireAdminSession(app, req, reply);
    if (!session) return;
    const cid = req.params?.cid;
    if (typeof cid !== 'string' || !UUID_RE.test(cid)) return notFound(req, reply);
    const customer = await findCustomerById(app.db, cid);
    if (!customer) return notFound(req, reply);
    const projects = await listProjectsByCustomer(app.db, cid);
    return renderAdmin(req, reply, 'admin/projects/list', {
      title: `Projects · ${customer.razon_social}`,
      customer,
      projects,
      mainWidth: 'wide',
      ...customerChrome(customer, 'projects'),
    });
  });

  app.get('/admin/customers/:cid/projects/new', async (req, reply) => {
    const session = await requireAdminSession(app, req, reply);
    if (!session) return;
    const cid = req.params?.cid;
    if (typeof cid !== 'string' || !UUID_RE.test(cid)) return notFound(req, reply);
    const customer = await findCustomerById(app.db, cid);
    if (!customer) return notFound(req, reply);
    return renderAdmin(req, reply, 'admin/projects/new', {
      title: 'New project',
      customer,
      csrfToken: await reply.generateCsrf(),
      form: null,
      mainWidth: 'content',
      ...customerChrome(customer, 'projects'),
    });
  });

  app.post('/admin/customers/:cid/projects',
    { preHandler: app.csrfProtection },
    async (req, reply) => {
      const session = await requireAdminSession(app, req, reply);
      if (!session) return;
      const cid = req.params?.cid;
      if (typeof cid !== 'string' || !UUID_RE.test(cid)) return notFound(req, reply);
      const customer = await findCustomerById(app.db, cid);
      if (!customer) return notFound(req, reply);

      const body = req.body ?? {};
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      const objetoProyecto = typeof body.objeto_proyecto === 'string' ? body.objeto_proyecto.trim() : '';
      if (!name || !objetoProyecto) {
        reply.code(422);
        return renderAdmin(req, reply, 'admin/projects/new', {
          title: 'New project',
          customer,
          csrfToken: await reply.generateCsrf(),
          form: { name, objeto_proyecto: objetoProyecto },
          error: 'Name and objeto del proyecto are required.',
          mainWidth: 'content',
          ...customerChrome(customer, 'projects'),
        });
      }

      let projectId;
      try {
        const r = await projectsService.create(app.db, {
          customerId: cid, name, objetoProyecto,
        }, makeCtx(req, session));
        projectId = r.projectId;
      } catch (err) {
        reply.code(422);
        return renderAdmin(req, reply, 'admin/projects/new', {
          title: 'New project',
          customer,
          csrfToken: await reply.generateCsrf(),
          form: { name, objeto_proyecto: objetoProyecto },
          error: err.message,
          mainWidth: 'content',
          ...customerChrome(customer, 'projects'),
        });
      }
      reply.redirect(`/admin/customers/${cid}/projects/${projectId}`, 302);
    });

  app.get('/admin/customers/:cid/projects/:id', async (req, reply) => {
    const session = await requireAdminSession(app, req, reply);
    if (!session) return;
    const { cid, id } = req.params ?? {};
    if (!UUID_RE.test(cid) || !UUID_RE.test(id)) return notFound(req, reply);
    const customer = await findCustomerById(app.db, cid);
    const project = await findProjectById(app.db, id);
    if (!customer || !project || project.customer_id !== cid) return notFound(req, reply);
    return renderAdmin(req, reply, 'admin/projects/detail', {
      title: project.name,
      customer,
      project,
      csrfToken: await reply.generateCsrf(),
      mainWidth: 'content',
      ...customerChrome(customer, 'projects'),
    });
  });

  app.post('/admin/customers/:cid/projects/:id',
    { preHandler: app.csrfProtection },
    async (req, reply) => {
      const session = await requireAdminSession(app, req, reply);
      if (!session) return;
      const { cid, id } = req.params ?? {};
      if (!UUID_RE.test(cid) || !UUID_RE.test(id)) return notFound(req, reply);
      const customer = await findCustomerById(app.db, cid);
      const project = await findProjectById(app.db, id);
      if (!customer || !project || project.customer_id !== cid) return notFound(req, reply);

      const body = req.body ?? {};
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      const objetoProyecto = typeof body.objeto_proyecto === 'string' ? body.objeto_proyecto.trim() : '';
      if (!name && !objetoProyecto) {
        reply.code(422);
        return renderAdmin(req, reply, 'admin/projects/detail', {
          title: project.name,
          customer,
          project,
          csrfToken: await reply.generateCsrf(),
          error: 'At least one of name or objeto del proyecto must change.',
          mainWidth: 'content',
          ...customerChrome(customer, 'projects'),
        });
      }
      try {
        await projectsService.update(app.db, {
          projectId: id,
          ...(name ? { name } : {}),
          ...(objetoProyecto ? { objetoProyecto } : {}),
        }, makeCtx(req, session));
      } catch (err) {
        reply.code(422);
        return renderAdmin(req, reply, 'admin/projects/detail', {
          title: project.name,
          customer,
          project,
          csrfToken: await reply.generateCsrf(),
          error: err.message,
          mainWidth: 'content',
          ...customerChrome(customer, 'projects'),
        });
      }
      reply.redirect(`/admin/customers/${cid}/projects/${id}`, 302);
    });

  app.post('/admin/customers/:cid/projects/:id/status',
    { preHandler: app.csrfProtection },
    async (req, reply) => {
      const session = await requireAdminSession(app, req, reply);
      if (!session) return;
      const { cid, id } = req.params ?? {};
      if (!UUID_RE.test(cid) || !UUID_RE.test(id)) return notFound(req, reply);
      const customer = await findCustomerById(app.db, cid);
      const project = await findProjectById(app.db, id);
      if (!customer || !project || project.customer_id !== cid) return notFound(req, reply);

      const status = typeof req.body?.status === 'string' ? req.body.status : '';
      try {
        await projectsService.updateStatus(app.db, {
          projectId: id, status,
        }, makeCtx(req, session));
      } catch (err) {
        reply.code(422);
        return renderAdmin(req, reply, 'admin/projects/detail', {
          title: project.name,
          customer,
          project,
          csrfToken: await reply.generateCsrf(),
          error: err.message,
          mainWidth: 'content',
          ...customerChrome(customer, 'projects'),
        });
      }
      reply.redirect(`/admin/customers/${cid}/projects/${id}`, 302);
    });
}
