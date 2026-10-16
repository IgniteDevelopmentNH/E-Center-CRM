import { badRequest } from '../lib/http.ts';
import type { Ctx } from '../router.ts';
import { putObject, safeFileName } from './storage.ts';

/**
 * Uploads from the community portal (profile photos, resumes) and from admins
 * (post images). Stricter than CRM documents: a short allow-list per purpose,
 * a smaller size cap, and the file's leading bytes must match its declared
 * type, so a renamed executable or HTML file is rejected even if its name and
 * Content-Type claim otherwise. Everything lands in the private R2 bucket and
 * is only ever served by the Worker behind an authorisation check.
 */

export type UploadPurpose = 'photo' | 'resume' | 'post-image';

const IMAGE_TYPES: Record<string, string[]> = {
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/png': ['.png'],
  'image/webp': ['.webp'],
};

const RESUME_TYPES: Record<string, string[]> = {
  'application/pdf': ['.pdf'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
  'application/msword': ['.doc'],
};

const ALLOWED: Record<UploadPurpose, Record<string, string[]>> = {
  photo: IMAGE_TYPES,
  'post-image': IMAGE_TYPES,
  resume: RESUME_TYPES,
};

const FRIENDLY: Record<UploadPurpose, string> = {
  photo: 'a JPEG, PNG or WebP image',
  'post-image': 'a JPEG, PNG or WebP image',
  resume: 'a PDF or Word document',
};

/** Checks the file's magic bytes against its declared type. */
export function contentMatchesType(bytes: Uint8Array, mimeType: string): boolean {
  const starts = (...sig: number[]) => sig.every((value, i) => bytes[i] === value);
  switch (mimeType) {
    case 'image/jpeg':
      return starts(0xff, 0xd8, 0xff);
    case 'image/png':
      return starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    case 'image/webp':
      return starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
    case 'application/pdf':
      return starts(0x25, 0x50, 0x44, 0x46);
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return starts(0x50, 0x4b, 0x03, 0x04);
    case 'application/msword':
      return starts(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1);
    default:
      return false;
  }
}

export interface StoredUpload {
  key: string;
  fileName: string;
  type: string;
  size: number;
}

/** Validates and stores the multipart `file` field. Throws a 400 naming the problem. */
export async function storeCommunityUpload(
  ctx: Ctx,
  input: { purpose: UploadPurpose; customerId: string; ownerId: string },
): Promise<StoredUpload> {
  let form: FormData;
  try {
    form = await ctx.req.formData();
  } catch {
    throw badRequest('Choose a file to upload.', 'File');
  }
  const entry = form.get('file');
  if (typeof entry === 'string' || !entry) throw badRequest('Choose a file to upload.', 'File');
  const file = entry as File;

  const maxBytes = ctx.config.communityUploadMaxBytes;
  if (file.size === 0) throw badRequest('That file is empty.', 'File');
  if (file.size > maxBytes) {
    throw badRequest(`That file is larger than the ${Math.round(maxBytes / (1024 * 1024))} MB limit.`, 'File');
  }

  const allowed = ALLOWED[input.purpose];
  const extensions = allowed[file.type];
  const dot = file.name.lastIndexOf('.');
  const extension = dot === -1 ? '' : file.name.slice(dot).toLowerCase();
  if (!extensions || !extensions.includes(extension)) {
    throw badRequest(`Upload ${FRIENDLY[input.purpose]}.`, 'File');
  }

  const body = await file.arrayBuffer();
  if (!contentMatchesType(new Uint8Array(body.slice(0, 16)), file.type)) {
    throw badRequest(`That file does not look like ${FRIENDLY[input.purpose]}.`, 'File');
  }

  const fileName = safeFileName(file.name);
  const folder = input.purpose === 'resume' ? 'resumes' : input.purpose === 'photo' ? 'photos' : 'posts';
  const key = `customers/${input.customerId}/community/${folder}/${input.ownerId}/${Date.now()}${extension}`;
  await putObject(ctx.env.DOCS, key, body, file.type);
  return { key, fileName, type: file.type, size: file.size };
}
