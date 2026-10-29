import { badRequest, jsonResponse } from '../lib/http.ts';
import { newId } from '../lib/ids.ts';
import { hashPassword } from '../lib/password.ts';
import { nowIso } from '../lib/time.ts';
import type { Ctx, Router } from '../router.ts';

/**
 * One-time account bootstrap for a freshly deployed, empty database.
 *
 * There is no admin UI to create the very first account (every user-management
 * route requires an existing owner), so this fills that one gap: it reads up
 * to two accounts to create from Worker secrets (never entered in chat, never
 * committed to the repo -- see wrangler.toml's comment on
 * BOOTSTRAP_OWNER_* / BOOTSTRAP_EDITOR_*). Each of the two accounts is
 * skipped independently if that email already exists, so this can be called
 * more than once -- e.g. to add the editor after fixing a typo'd secret --
 * without disturbing an account already created.
 *
 * After using it: `wrangler secret delete BOOTSTRAP_OWNER_PASSWORD` (and the
 * editor one, if set). Leaving them set is harmless (an already-created email
 * is just skipped), but there is no reason to keep a password sitting there.
 */
export function register(router: Router): void {
  router.post('/api/bootstrap', async (ctx: Ctx) => {
    const timestamp = nowIso();
    const { db, config } = ctx;

    let customer = await db.get<{ id: string }>(`SELECT id FROM customers WHERE slug = ?`, [
      config.defaultCustomer.slug,
    ]);
    const customerId = customer?.id ?? newId();
    if (!customer) {
      await db.run(`INSERT INTO customers (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`, [
        customerId,
        config.defaultCustomer.name,
        config.defaultCustomer.slug,
        timestamp,
        timestamp,
      ]);
    }

    async function createIfMissing(
      email: string | undefined,
      name: string | undefined,
      password: string | undefined,
      role: 'owner' | 'editor',
    ): Promise<'created' | 'skipped-exists' | 'skipped-unset'> {
      if (!email || !name || !password) return 'skipped-unset';

      const existing = await db.get<{ id: string }>(
        `SELECT id FROM users WHERE LOWER(email) = ? AND deleted_at IS NULL`,
        [email.toLowerCase()],
      );
      if (existing) return 'skipped-exists';

      const id = newId();
      await db.batch([
        {
          sql: `INSERT INTO users (id, customer_id, email, password_hash, name, role, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          params: [id, customerId, email.toLowerCase(), await hashPassword(password), name, role, timestamp, timestamp],
        },
        {
          sql: `INSERT INTO user_preferences (user_id, customer_id, updated_at) VALUES (?, ?, ?)`,
          params: [id, customerId, timestamp],
        },
      ]);
      return 'created';
    }

    const ownerResult = await createIfMissing(
      ctx.env.BOOTSTRAP_OWNER_EMAIL,
      ctx.env.BOOTSTRAP_OWNER_NAME,
      ctx.env.BOOTSTRAP_OWNER_PASSWORD,
      'owner',
    );
    const editorResult = await createIfMissing(
      ctx.env.BOOTSTRAP_EDITOR_EMAIL,
      ctx.env.BOOTSTRAP_EDITOR_NAME,
      ctx.env.BOOTSTRAP_EDITOR_PASSWORD,
      'editor',
    );

    if (ownerResult === 'skipped-unset' && editorResult === 'skipped-unset') {
      throw badRequest(
        'Set BOOTSTRAP_OWNER_EMAIL / _NAME / _PASSWORD (and optionally the _EDITOR_ ones) as Worker secrets first.',
      );
    }

    return jsonResponse({
      ok: true,
      owner: { email: ctx.env.BOOTSTRAP_OWNER_EMAIL?.toLowerCase() ?? null, result: ownerResult },
      editor: { email: ctx.env.BOOTSTRAP_EDITOR_EMAIL?.toLowerCase() ?? null, result: editorResult },
      note: 'Now run: wrangler secret delete BOOTSTRAP_OWNER_PASSWORD (and BOOTSTRAP_EDITOR_PASSWORD, if set).',
    });
  });
}
