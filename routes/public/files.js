import {
  consumeDownloadToken,
  readVerifiedDocumentBytes,
  TokenInvalidError,
  TokenExpiredError,
  TokenAlreadyConsumedError,
  DocumentNotFoundError,
  IntegrityFailureError,
} from '../../domain/documents/service.js';

export function registerPublicFilesRoutes(app) {
  // The route is declared as `/files/*` (not `/files/:token`) because
  // fastify's underlying router (find-my-way) treats `.` as a marker for
  // static-suffix matching on named params, which prevents `:token` from
  // matching tokens like `<base64url>.<base64url>`. Wildcard matching has
  // no such suffix logic.
  app.get('/files/*', async (req, reply) => {
    const token = req.params?.['*'];
    if (typeof token !== 'string' || token.length < 10) {
      reply.code(400);
      return { error: 'invalid token' };
    }

    let doc;
    try {
      doc = await consumeDownloadToken(app.db, {
        token,
        secret: app.env.FILE_URL_SIGNING_SECRET,
      });
    } catch (err) {
      const status = err.status ?? 500;
      reply.code(status);
      if (err instanceof TokenInvalidError) return { error: 'invalid token' };
      if (err instanceof TokenExpiredError) return { error: 'token expired' };
      if (err instanceof TokenAlreadyConsumedError) return { error: 'token already consumed' };
      if (err instanceof DocumentNotFoundError) return { error: 'document not found' };
      throw err;
    }

    let bytes;
    try {
      bytes = await readVerifiedDocumentBytes(app.db, doc, {
        actorType: 'system',
        ip: req.ip ?? null,
      });
    } catch (err) {
      if (err instanceof IntegrityFailureError) {
        reply.code(500);
        return { error: 'file integrity failure' };
      }
      throw err;
    }

    reply.header('content-type', doc.mime_type);
    reply.header(
      'content-disposition',
      `attachment; filename="${doc.original_filename.replace(/"/g, '')}"`,
    );
    reply.header('content-length', String(bytes.length));
    reply.header('cache-control', 'private, no-store');
    return reply.send(bytes);
  });
}
