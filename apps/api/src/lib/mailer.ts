import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../env';

/**
 * Server-side transactional email. Provider priority:
 *   1. SMTP (e.g. a Gmail account + app password) — delivers to any address
 *   2. Resend (RESEND_API_KEY)
 *   3. console — just logs, reported as delivered:false / provider:'console'
 * The caller records the result honestly and never tells the customer an email
 * went out when it did not. No provider secret ever reaches the frontend.
 */
export type MailProvider = 'smtp' | 'resend' | 'console';
export type MailResult =
  | { delivered: true; provider: 'smtp' | 'resend'; id: string }
  | { delivered: false; provider: 'console' }
  | { delivered: false; provider: 'smtp' | 'resend'; error: string };

interface Mail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

const smtpEnabled = Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS);

let _transport: Transporter | null = null;
function transport(): Transporter {
  if (!_transport) {
    _transport = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_PORT === 465,
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    });
  }
  return _transport;
}

async function sendViaSmtp(mail: Mail): Promise<MailResult> {
  try {
    const info = await transport().sendMail({
      from: env.EMAIL_FROM,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    });
    return { delivered: true, provider: 'smtp', id: info.messageId };
  } catch (err) {
    return { delivered: false, provider: 'smtp', error: String((err as Error).message ?? err) };
  }
}

async function sendViaResend(mail: Mail): Promise<MailResult> {
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.EMAIL_FROM,
        to: mail.to,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
    if (!res.ok) {
      return { delivered: false, provider: 'resend', error: body.message ?? `HTTP ${res.status}` };
    }
    return { delivered: true, provider: 'resend', id: body.id ?? 'unknown' };
  } catch (err) {
    return { delivered: false, provider: 'resend', error: String((err as Error).message ?? err) };
  }
}

export async function sendEmail(mail: Mail): Promise<MailResult> {
  if (smtpEnabled) return sendViaSmtp(mail);
  if (env.RESEND_API_KEY) return sendViaResend(mail);
  console.log(
    `[mailer:console] to=${mail.to}\n  subject: ${mail.subject}\n  ${mail.text.replace(/\n/g, '\n  ')}`,
  );
  return { delivered: false, provider: 'console' };
}

export interface WelcomeEmailInput {
  to: string;
  restaurantName: string;
  ownerName?: string | null;
  planName: string;
  billingInterval: string;
  portalUrl: string;
  /** Temporary password to sign in with (owner changes it after first login). */
  tempPassword?: string | null;
  /** Secure single-use link to set a new password (claim link). */
  setupUrl?: string | null;
}

/** Branded welcome email — restaurant name, plan, payment confirmation, portal
 *  link, a temporary password, and a change-password link. No infrastructure
 *  detail (no Supabase keys / project URLs). */
export function sendWelcomeEmail(i: WelcomeEmailInput): Promise<MailResult> {
  const hello = i.ownerName ? `Welcome to Automation Restaurant, ${i.ownerName}.` : 'Welcome to Automation Restaurant.';
  const cycle = i.billingInterval === 'annual' ? 'Annual' : 'Monthly';

  const text = [
    hello,
    ``,
    `Your subscription for ${i.restaurantName} has been successfully activated.`,
    ``,
    `Plan: ${i.planName}`,
    `Billing: ${cycle}`,
    `Payment: Confirmed`,
    ``,
    `Your restaurant workspace is now ready.`,
    ``,
    `Portal:   ${i.portalUrl}`,
    `Email:    ${i.to}`,
    i.tempPassword ? `Password: ${i.tempPassword}   (temporary — change it after you sign in)` : ``,
    ``,
    i.setupUrl ? `Prefer to set your own password now? Use this secure link (expires soon):\n${i.setupUrl}` : ``,
    ``,
    `Need help? Contact ${env.SUPPORT_EMAIL}.`,
    ``,
    `Welcome to Automation Restaurant.`,
  ]
    .filter((l) => l !== undefined)
    .join('\n');

  const html = `<!doctype html><html><body style="margin:0;background:#f6f7f9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1c1e21">
  <div style="max-width:520px;margin:0 auto;padding:32px 24px">
    <div style="font-weight:800;font-size:18px;margin-bottom:24px">Automation Restaurant</div>
    <div style="background:#fff;border:1px solid #e6e8eb;border-radius:12px;padding:28px">
      <h1 style="font-size:18px;margin:0 0 12px">${hello}</h1>
      <p style="font-size:14px;line-height:1.6;margin:0 0 16px">Your subscription for <strong>${i.restaurantName}</strong> has been successfully activated and your restaurant workspace is now ready.</p>
      <table style="font-size:13px;width:100%;border-collapse:collapse;margin:0 0 20px">
        <tr><td style="padding:6px 0;color:#65676b">Plan</td><td style="padding:6px 0;text-align:right;font-weight:600">${i.planName}</td></tr>
        <tr><td style="padding:6px 0;color:#65676b">Billing</td><td style="padding:6px 0;text-align:right;font-weight:600">${cycle}</td></tr>
        <tr><td style="padding:6px 0;color:#65676b">Payment</td><td style="padding:6px 0;text-align:right;font-weight:600;color:#1a7f37">Confirmed</td></tr>
      </table>
      <div style="background:#f6f7f9;border:1px solid #e6e8eb;border-radius:8px;padding:14px 16px;font-size:13px;margin:0 0 18px">
        <div style="color:#65676b;margin-bottom:6px">Sign in to your portal</div>
        <div><strong>Email:</strong> ${i.to}</div>
        ${i.tempPassword ? `<div><strong>Temporary password:</strong> <code style="background:#fff;border:1px solid #e6e8eb;border-radius:4px;padding:1px 5px">${i.tempPassword}</code></div><div style="color:#65676b;margin-top:6px">Change it under Settings after you sign in.</div>` : ''}
      </div>
      <a href="${i.portalUrl}" style="display:inline-block;background:#e8590c;color:#fff;font-weight:700;font-size:14px;text-decoration:none;padding:12px 22px;border-radius:8px">Open your restaurant portal</a>
      ${
        i.setupUrl
          ? `<p style="font-size:13px;line-height:1.6;margin:20px 0 0">Prefer to set your own password now? <a href="${i.setupUrl}" style="color:#e8590c">Use this secure link</a> (expires soon).</p>`
          : ''
      }
    </div>
    <p style="font-size:12px;color:#65676b;margin:20px 0 0">Need help? Contact <a href="mailto:${env.SUPPORT_EMAIL}" style="color:#65676b">${env.SUPPORT_EMAIL}</a>.</p>
  </div></body></html>`;

  return sendEmail({
    to: i.to,
    subject: 'Welcome to Automation Restaurant — Your Portal Is Ready',
    html,
    text,
  });
}
