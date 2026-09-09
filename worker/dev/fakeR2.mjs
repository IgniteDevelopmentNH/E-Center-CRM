/**
 * A local stand-in for a Cloudflare R2 bucket binding, backed by the
 * filesystem. Implements just the surface worker/src/services/storage.ts uses:
 * put/get/delete, with httpMetadata.contentType round-tripped via a sidecar
 * `.meta.json` file (R2 stores this as real object metadata; there is no
 * simple filesystem equivalent, so it is kept alongside instead).
 */
import fs from 'node:fs/promises';
import path from 'node:path';

export function createFakeR2(rootDir) {
  function pathFor(key) {
    const normalised = path.normalize(key).replace(/^(\.\.[/\\])+/, '');
    return path.join(rootDir, normalised);
  }

  return {
    async put(key, value, options = {}) {
      const target = pathFor(key);
      await fs.mkdir(path.dirname(target), { recursive: true });
      const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
      await fs.writeFile(target, buffer);
      await fs.writeFile(
        `${target}.meta.json`,
        JSON.stringify({ httpMetadata: options.httpMetadata ?? {} }),
      );
      return { key };
    },

    async get(key) {
      const target = pathFor(key);
      let data;
      try {
        data = await fs.readFile(target);
      } catch {
        return null;
      }
      let httpMetadata = {};
      try {
        httpMetadata = JSON.parse(await fs.readFile(`${target}.meta.json`, 'utf8')).httpMetadata ?? {};
      } catch {
        // No sidecar file -- fine, metadata just comes back empty.
      }
      return {
        key,
        httpMetadata,
        arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
        text: async () => data.toString('utf8'),
      };
    },

    async delete(key) {
      const target = pathFor(key);
      await fs.rm(target, { force: true });
      await fs.rm(`${target}.meta.json`, { force: true });
    },
  };
}
