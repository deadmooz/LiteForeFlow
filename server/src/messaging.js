import { httpRequest, publicHost } from './http.js';
import { config } from './config.js';

/*
 * The raw calls to Slack, Telegram and an SMTP server. The Slack/Telegram/Email blocks and the failure alerts all go through
 * here, so addresses, timeouts and the SMTP settings live in one place. Each caller words its own errors.
 */

/** Slack chat.postMessage. Returns Slack's answer ({ ok, error, channel, ts }). */
export async function slackPost(token, channel, text, { timeoutMs } = {}) {
  const res = await httpRequest({
    method: 'POST', url: `${config.slackApiUrl}/chat.postMessage`, headers: { authorization: `Bearer ${token}` }, body: { channel, text }, timeoutMs,
  });
  return res.data;
}

/** Telegram sendMessage. Returns Telegram's answer ({ ok, result, description }); a refused call is an answer, not an exception. */
export async function telegramSend(token, body, { timeoutMs, ignoreStatus } = {}) {
  const res = await httpRequest({ method: 'POST', url: `${config.telegramApiUrl}/bot${token}/sendMessage`, body, timeoutMs, ignoreStatus });
  return res.data;
}

/** An SMTP transport built from an "smtp" credential. */
export async function smtpTransport(cred, extra = {}) {
  const nodemailer = (await import('nodemailer')).default;
  return nodemailer.createTransport({
    host: await publicHost(cred.host), port: Number(cred.port) || 587, secure: !!cred.secure, tls: { servername: cred.host },
    auth: cred.user ? { user: cred.user, pass: cred.password } : undefined, ...extra,
  });
}
