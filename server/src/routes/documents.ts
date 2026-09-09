import { Router } from 'express';
import multer from 'multer';
import { getDb } from '../db/index.ts';
import { env } from '../env.ts';
import { audit } from '../lib/audit.ts';
import { badRequest, notFound, route, unauthorized } from '../lib/http.ts';
import { newId } from '../lib/ids.ts';
import { signToken, verifyToken } from '../lib/jwt.ts';
import { nowIso } from '../lib/time.ts';
import { optionalId } from '../lib/validate.ts';
import { auth, requireAuth, requireEditor } from '../middleware/auth.ts';
import { documentOut } from '../records.ts';
import {
  buildStorageKey,
  deleteObject,
  getObject,
  getPresignedUrl,
  isAllowedFile,
  putObject,
  safeFileName,
} from '../services/storage.ts';

export const documentsRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.uploadMaxBytes, files: 1 },
  fileFilter: (_req, file, callback) => {
    if (!isAllowedFile(file.mimetype, file.originalname)) {
      callback(badRequest('That file type is not allowed. Upload a PDF, image, Word, Excel or text file.'));
      return;
    }
    callback(null, true);
  },
});

const SELECT_DOCUMENT = `
  SELECT d.*, u.name AS uploaded_by_name
    FROM documents d
    LEFT JOIN users u ON u.id = d.uploaded_by`;

/**
 * Streaming download for the local storage driver, authorised by a short-lived
 * signed token rather than the session header, so it can be used as a plain URL.
 * Declared before `requireAuth` for that reason.
 */
documentsRouter.get(
  '/:id/raw',
  route(async (req, res) => {
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    const payload = verifyToken(token);
    if (!payload || payload.role !== 'download' || payload.sub !== req.params.id) {
      throw unauthorized('That download link has expired.');
    }

    const db = await getDb();
    const document = await db.get<{ file_name: string; file_type: string; storage_key: string }>(
      `SELECT file_name, file_type, storage_key FROM documents
        WHERE id = ? AND customer_id = ? AND deleted_at IS NULL`,
      [req.params.id!, payload.cid],
    );
    if (!document) throw notFound('That document no longer exists.');

    const body = await getObject(document.storage_key);
    res.header('Content-Type', document.file_type);
    res.header('Content-Disposition', `attachment; filename="${safeFileName(document.file_name)}"`);
    res.send(body);
  }),
);

documentsRouter.use(requireAuth);

documentsRouter.get(
  '/',
  route(async (req, res) => {
    const { customerId } = auth(req);
    const db = await getDb();
    const where = ['d.customer_id = ?', 'd.deleted_at IS NULL'];
    const params: (string | number)[] = [customerId];

    if (typeof req.query.contactId === 'string' && req.query.contactId) {
      where.push('d.contact_id = ?');
      params.push(req.query.contactId);
    }
    if (typeof req.query.organizationId === 'string' && req.query.organizationId) {
      where.push('d.organization_id = ?');
      params.push(req.query.organizationId);
    }

    const rows = await db.all(
      `${SELECT_DOCUMENT} WHERE ${where.join(' AND ')} ORDER BY d.created_at DESC LIMIT 200`,
      params,
    );
    res.json({ documents: rows.map(documentOut) });
  }),
);

documentsRouter.post(
  '/',
  requireEditor,
  upload.single('file'),
  route(async (req, res) => {
    const { customerId, userId } = auth(req);
    const file = req.file;
    if (!file) throw badRequest('Choose a file to upload.', 'File');

    const contactId = optionalId(req.body?.contactId, 'Contact');
    const organizationId = optionalId(req.body?.organizationId, 'Organization');
    if (!contactId && !organizationId) {
      throw badRequest('Attach the document to a contact or an organization.', 'Contact');
    }

    const db = await getDb();
    // Confirm the parent belongs to this tenant before writing anything.
    if (contactId) {
      const contact = await db.get(
        `SELECT id FROM contacts WHERE id = ? AND customer_id = ? AND deleted_at IS NULL`,
        [contactId, customerId],
      );
      if (!contact) throw badRequest('That contact was not found.', 'Contact');
    }
    if (organizationId) {
      const org = await db.get(
        `SELECT id FROM organizations WHERE id = ? AND customer_id = ? AND deleted_at IS NULL`,
        [organizationId, customerId],
      );
      if (!org) throw badRequest('That organization was not found.', 'Organization');
    }

    const fileName = safeFileName(file.originalname);
    const storageKey = buildStorageKey(customerId, fileName);
    await putObject(storageKey, file.buffer, file.mimetype);

    const id = newId();
    await db.run(
      `INSERT INTO documents
         (id, customer_id, contact_id, organization_id, file_name, file_size, file_type,
          storage_key, uploaded_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        customerId,
        contactId,
        organizationId,
        fileName,
        file.size,
        file.mimetype,
        storageKey,
        userId,
        nowIso(),
      ],
    );

    await audit(db, {
      customerId,
      userId,
      action: 'document.upload',
      entityType: 'document',
      entityId: id,
      metadata: { fileName, fileSize: file.size, contactId, organizationId },
      req,
    });

    const row = await db.get(`${SELECT_DOCUMENT} WHERE d.id = ?`, [id]);
    res.status(201).json({ document: documentOut(row!) });
  }),
);

/** Issues a time-limited download URL and records the access. */
documentsRouter.get(
  '/:id/download',
  route(async (req, res) => {
    const { customerId, userId } = auth(req);
    const db = await getDb();
    const document = await db.get<{ id: string; file_name: string; storage_key: string }>(
      `SELECT id, file_name, storage_key FROM documents
        WHERE id = ? AND customer_id = ? AND deleted_at IS NULL`,
      [req.params.id!, customerId],
    );
    if (!document) throw notFound('That document no longer exists.');

    await audit(db, {
      customerId,
      userId,
      action: 'document.download',
      entityType: 'document',
      entityId: document.id,
      metadata: { fileName: document.file_name },
      req,
    });

    const presigned = await getPresignedUrl(document.storage_key, document.file_name);
    if (presigned) {
      res.json({ url: presigned, expiresInSeconds: env.downloadUrlTtlSeconds });
      return;
    }

    const token = signToken(
      { sub: document.id, cid: customerId, email: '', name: '', role: 'download' },
      env.downloadUrlTtlSeconds,
    );
    res.json({
      url: `/api/documents/${document.id}/raw?token=${encodeURIComponent(token)}`,
      expiresInSeconds: env.downloadUrlTtlSeconds,
    });
  }),
);

/**
 * Soft-deletes the record and removes the stored bytes. The row is retained so
 * the audit trail still shows what existed and who removed it.
 */
documentsRouter.delete(
  '/:id',
  requireEditor,
  route(async (req, res) => {
    const { customerId, userId } = auth(req);
    const db = await getDb();
    const document = await db.get<{ id: string; file_name: string; storage_key: string }>(
      `SELECT id, file_name, storage_key FROM documents
        WHERE id = ? AND customer_id = ? AND deleted_at IS NULL`,
      [req.params.id!, customerId],
    );
    if (!document) throw notFound('That document no longer exists.');

    await db.run(`UPDATE documents SET deleted_at = ?, deleted_by = ? WHERE id = ? AND customer_id = ?`, [
      nowIso(),
      userId,
      document.id,
      customerId,
    ]);
    await deleteObject(document.storage_key).catch((error: unknown) => {
      console.error('[documents] failed to remove stored object', error);
    });

    await audit(db, {
      customerId,
      userId,
      action: 'document.delete',
      entityType: 'document',
      entityId: document.id,
      metadata: { fileName: document.file_name },
      req,
    });
    res.json({ ok: true });
  }),
);
