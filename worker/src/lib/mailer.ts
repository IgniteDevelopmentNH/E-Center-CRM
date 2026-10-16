import type { Ctx } from '../router.ts';

/**
 * Transactional email (verification and password-reset links) through
 * Cloudflare Email Service's `send_email` Worker binding -- no API keys, no
 * extra service. Until a sending domain is onboarded and the binding is
 * configured (see README "Email"), sendMail reports `false` honestly: callers
 * surface "we could not send the email" rather than pretending it went out.
 *
 * Local development can set EMAIL_DEV_LOG=true to print the message (and the
 * link in it) to the dev-server console instead.
 */

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export async function sendMail(ctx: Ctx, message: MailMessage): Promise<boolean> {
  const binding = ctx.env.EMAIL;
  const from = ctx.config.mail.from;

  if (binding && from) {
    try {
      await binding.send({
        to: message.to,
        from: { email: from, name: ctx.config.mail.fromName },
        subject: message.subject,
        text: message.text,
        html: message.html,
      });
      return true;
    } catch (error) {
      console.error('[mail] send failed', error);
      return false;
    }
  }

  if (ctx.config.mail.devLog) {
    console.log(`\n[mail:dev] To: ${message.to}\n[mail:dev] Subject: ${message.subject}\n${message.text}\n`);
    return true;
  }

  console.warn('[mail] EMAIL binding or MAIL_FROM not configured; message not sent.');
  return false;
}

/** Absolute base URL for links in emails: APP_URL if set, else the request's own origin. */
export function appBaseUrl(ctx: Ctx): string {
  return (ctx.config.appUrl || ctx.url.origin).replace(/\/+$/, '');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** A minimal single-action email in both text and HTML. */
export function actionEmail(input: {
  to: string;
  subject: string;
  greeting: string;
  intro: string;
  actionLabel: string;
  url: string;
  outro: string;
}): MailMessage {
  const text = `${input.greeting}\n\n${input.intro}\n\n${input.actionLabel}: ${input.url}\n\n${input.outro}\n\n-- UNH ECenter`;
  const html = `<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;color:#1e293b;max-width:520px">
<p>${escapeHtml(input.greeting)}</p>
<p>${escapeHtml(input.intro)}</p>
<p><a href="${escapeHtml(input.url)}" style="display:inline-block;background:#003366;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">${escapeHtml(input.actionLabel)}</a></p>
<p style="font-size:13px;color:#64748b">Or paste this link into your browser:<br>${escapeHtml(input.url)}</p>
<p style="font-size:13px;color:#64748b">${escapeHtml(input.outro)}</p>
<p style="font-size:13px;color:#64748b">UNH ECenter</p></div>`;
  return { to: input.to, subject: input.subject, text, html };
}
