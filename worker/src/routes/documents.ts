import { audit } from '../lib/audit.ts';
import { badRequest, jsonResponse, notFound, readJson, unauthorized } from '../lib/http.ts';
import { newId } from '../lib/ids.ts';
import { signValue, verifyValue } from '../lib/signedToken.ts';
import { nowIso } from '../lib/time.ts';
import { optionalId, requiredString } from '../lib/validate.ts';
import { requireAuth, requireEditor } from '../middleware/auth.ts';
import { documentOut } from '../records.ts';
import type { Ctx, Router } from '../router.ts';
import {
  buildStorageKey,
  deleteObject,
  getObject,
  getObjectType,
  isAllowedFile,
  putObject,
  safeFileName,
} from '../services/storage.ts';

const SELECT_DOCUMENT = `
  SELECT d.*, u.name AS uploaded_by_name
    FROM documents d
    LEFT JOIN users u ON u.id = d.uploaded_by`;

export function register(router: Router): void {
  router.get('/api/documents', async (ctx: Ctx) => {
    const { customerId } = requireAuth(ctx);
    const where = ['d.customer_id = ?', 'd.deleted_at IS NULL'];
    const params: (string | number)[] = [customerId];

    const contactId = ctx.query.get('contactId');
    if (contactId) {
      where.push('d.contact_id = ?');
      params.push(contactId);
    }
    const organizationId = ctx.query.get('organizationId');
    if (organizationId) {
      where.push('d.organization_id = ?');
      params.push(organizationId);
    }
    const noteId = ctx.query.get('noteId');
    if (noteId) {
      where.push('d.note_id = ?');
      params.push(noteId);
    }

    const rows = await ctx.db.all(
      `${SELECT_DOCUMENT} WHERE ${where.join(' AND ')} ORDER BY d.created_at DESC LIMIT 200`,
      params,
    );
    return jsonResponse({ documents: rows.map(documentOut) });
  });

  router.post('/api/documents', async (ctx: Ctx) => {
    const { customerId, userId } = requireEditor(ctx);

    const form = await ctx.req.formData();
    const entry = form.get('file');
    // form.get() returns `File | string | null`. @cloudflare/workers-types'
    // File has no runtime constructor value TS can narrow with `instanceof`,
    // so check for the one other possibility (a plain string field) instead.
    if (typeof entry === 'string' || !entry) {
      throw badRequest('Choose a file to upload.', 'File');
    }
    const file = entry as File;
    if (file.size > ctx.config.uploadMaxBytes) {
      throw badRequest(
        `That file is larger than the ${Math.round(ctx.config.uploadMaxBytes / (1024 * 1024))}MB limit.`,
      );
    }
    if (!isAllowedFile(file.type, file.name)) {
      throw badRequest('That file type is not allowed. Upload a PDF, image, Word, Excel or text file.');
    }

    const contactId = optionalId(form.get('contactId'), 'Contact');
    const organizationId = optionalId(form.get('organizationId'), 'Organization');
    const noteId = optionalId(form.get('noteId'), 'Note');
    if (!contactId && !organizationId && !noteId) {
      throw badRequest('Attach the document to a contact, organization or note.', 'Contact');
    }

    // Confirm the parent belongs to this tenant before writing anything.
    if (contactId) {
      const contact = await ctx.db.get(
        `SELECT id FROM contacts WHERE id = ? AND customer_id = ? AND deleted_at IS NULL`,
        [contactId, customerId],
      );
      if (!contact) throw badRequest('That contact was not found.', 'Contact');
    }
    if (organizationId) {
      const org = await ctx.db.get(
        `SELECT id FROM organizations WHERE id = ? AND customer_id = ? AND deleted_at IS NULL`,
        [organizationId, customerId],
      );
      if (!org) throw badRequest('That organization was not found.', 'Organization');
    }
    if (noteId) {
      const note = await ctx.db.get(
        `SELECT id FROM notes WHERE id = ? AND customer_id = ? AND deleted_at IS NULL`,
        [noteId, customerId],
      );
      if (!note) throw badRequest('That note was not found.', 'Note');
    }

    const fileName = safeFileName(file.name);
    const storageKey = buildStorageKey(customerId, fileName);
    await putObject(ctx.env.DOCS, storageKey, await file.arrayBuffer(), file.type);

    const id = newId();
    await ctx.db.run(
      `INSERT INTO documents
         (id, customer_id, contact_id, organization_id, note_id, file_name, file_size, file_type,
          storage_key, uploaded_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, customerId, contactId, organizationId, noteId, fileName, file.size, file.type, storageKey, userId, nowIso()],
    );

    await audit(ctx.db, {
      customerId,
      userId,
      action: 'document.upload',
      entityType: 'document',
      entityId: id,
      metadata: { fileName, fileSize: file.size, contactId, organizationId, noteId },
      req: ctx.req,
    });

    const row = await ctx.db.get(`${SELECT_DOCUMENT} WHERE d.id = ?`, [id]);
    return jsonResponse({ document: documentOut(row!) }, { status: 201 });
  });

  /** Renames a document. Only the display/download name changes; the stored bytes stay put. */
  router.put('/api/documents/:id', async (ctx: Ctx) => {
    const { customerId, userId } = requireEditor(ctx);
    const existing = await ctx.db.get<{ id: string }>(
      `SELECT id FROM documents WHERE id = ? AND customer_id = ? AND deleted_at IS NULL`,
      [ctx.params.id!, customerId],
    );
    if (!existing) throw notFound('That document no longer exists.');

    const body = await readJson(ctx.req);
    const fileName = safeFileName(requiredString(body.fileName, 'File name', { max: 255 }));
    await ctx.db.run(`UPDATE documents SET file_name = ? WHERE id = ? AND customer_id = ?`, [
      fileName,
      ctx.params.id!,
      customerId,
    ]);

    const row = await ctx.db.get(`${SELECT_DOCUMENT} WHERE d.id = ?`, [ctx.params.id!]);
    return jsonResponse({ document: documentOut(row!) });
  });

  /** Issues a time-limited download URL and records the access. */
  router.get('/api/documents/:id/download', async (ctx: Ctx) => {
    const { customerId, userId } = requireAuth(ctx);
    const document_ = await ctx.db.get<{ id: string; file_name: string; storage_key: string }>(
      `SELECT id, file_name, storage_key FROM documents
        WHERE id = ? AND customer_id = ? AND deleted_at IS NULL`,
      [ctx.params.id!, customerId],
    );
    if (!document_) throw notFound('That document no longer exists.');

    await audit(ctx.db, {
      customerId,
      userId,
      action: 'document.download',
      entityType: 'document',
      entityId: document_.id,
      metadata: { fileName: document_.file_name },
      req: ctx.req,
    });

    const token = await signValue(
      { documentId: document_.id, customerId },
      ctx.config.tokenSecret,
      ctx.config.downloadUrlTtlSeconds,
    );
    return jsonResponse({
      url: `/api/documents/${document_.id}/raw?token=${encodeURIComponent(token)}`,
      expiresInSeconds: ctx.config.downloadUrlTtlSeconds,
    });
  });

  /**
   * Streams the file, authorised by the short-lived signed token above rather
   * than the session header, so it works as a plain link/new-tab download.
   */
  router.get('/api/documents/:id/raw', async (ctx: Ctx) => {
    const token = ctx.query.get('token') ?? '';
    const payload = await verifyValue(token, ctx.config.tokenSecret);
    if (!payload || payload.documentId !== ctx.params.id) {
      throw unauthorized('That download link has expired.');
    }

    const document_ = await ctx.db.get<{ file_name: string; file_type: string; storage_key: string }>(
      `SELECT file_name, file_type, storage_key FROM documents
        WHERE id = ? AND customer_id = ? AND deleted_at IS NULL`,
      [ctx.params.id!, payload.customerId],
    );
    if (!document_) throw notFound('That document no longer exists.');

    const body = await getObject(ctx.env.DOCS, document_.storage_key);
    const contentType = (await getObjectType(ctx.env.DOCS, document_.storage_key)) ?? document_.file_type;
    return new Response(body, {
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${safeFileName(document_.file_name)}"`,
      },
    });
  });

  /**
   * Soft-deletes the record and removes the stored bytes. The row is retained so
   * the audit trail still shows what existed and who removed it.
   */
  router.delete('/api/documents/:id', async (ctx: Ctx) => {
    const { customerId, userId } = requireEditor(ctx);
    const document_ = await ctx.db.get<{ id: string; file_name: string; storage_key: string }>(
      `SELECT id, file_name, storage_key FROM documents
        WHERE id = ? AND customer_id = ? AND deleted_at IS NULL`,
      [ctx.params.id!, customerId],
    );
    if (!document_) throw notFound('That document no longer exists.');

    await ctx.db.run(`UPDATE documents SET deleted_at = ?, deleted_by = ? WHERE id = ? AND customer_id = ?`, [
      nowIso(),
      userId,
      document_.id,
      customerId,
    ]);
    try {
      await deleteObject(ctx.env.DOCS, document_.storage_key);
    } catch (error) {
      console.error('[documents] failed to remove stored object', error);
    }

    await audit(ctx.db, {
      customerId,
      userId,
      action: 'document.delete',
      entityType: 'document',
      entityId: document_.id,
      metadata: { fileName: document_.file_name },
      req: ctx.req,
    });
    return jsonResponse({ ok: true });
  });
}
