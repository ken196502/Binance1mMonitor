import { fetch, ProxyAgent, EnvHttpProxyAgent, type Dispatcher } from 'undici';

export interface MiningNotice {
  id: string;
  text: string;
  attempts: number;
  nextAttemptAt: number;
  sentAt?: string;
  messageId?: number;
  lastError?: string;
}
export type Delivery = { ok: true; messageId: number } | { ok: false; error: string; retryAfterSeconds?: number };
export type Sender = (text: string) => Promise<Delivery>;

/** Dedicated bounded sender: validates Telegram's JSON acknowledgement. */
export function createMiningSender(): { send: Sender; close: () => Promise<void> } {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId) throw new Error('成果播报需要 .env 的 TELEGRAM_BOT_TOKEN 和 TELEGRAM_CHAT_ID；离线研究可显式使用 --no-telegram');
  const base = (process.env.TELEGRAM_API_BASE ?? 'https://api.telegram.org').replace(/\/$/, '');
  const url = new URL(base);
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname)) throw new Error('Telegram API 必须使用 HTTPS');
  const proxy = process.env.PROXY ?? process.env.BINANCE_PROXY;
  const dispatcher: Dispatcher = proxy ? new ProxyAgent(proxy) : new EnvHttpProxyAgent();
  return {
    async send(text) {
      try {
        const response = await fetch(`${base}/bot${token}/sendMessage`, {
          method: 'POST', dispatcher, signal: AbortSignal.timeout(15_000),
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
        });
        const body = await response.json() as { ok?: boolean; result?: { message_id?: number }; parameters?: { retry_after?: number } };
        if (response.ok && body.ok === true && Number.isInteger(body.result?.message_id)) return { ok: true, messageId: body.result!.message_id! };
        return { ok: false, error: `Telegram HTTP ${response.status}, ok=${body.ok === true}`, retryAfterSeconds: body.parameters?.retry_after };
      } catch (e) {
        // Never include request URLs (which contain bot credentials) in logs.
        return { ok: false, error: `Telegram 网络请求失败 (${e instanceof Error ? e.name : 'unknown'})` };
      }
    },
    close: () => dispatcher.close(),
  };
}

/** Caller checkpoints the notice together with its round BEFORE calling flush. */
export async function flushNotices(notices: MiningNotice[], send: Sender, save: () => Promise<void>, now = Date.now()) {
  for (const notice of notices) {
    if (notice.sentAt) continue;
    if (notice.nextAttemptAt > now) break;
    const result = await send(notice.text);
    notice.attempts++;
    if (result.ok) {
      notice.sentAt = new Date().toISOString(); notice.messageId = result.messageId; delete notice.lastError;
    } else {
      notice.lastError = result.error;
      const serverDelay = Number.isFinite(result.retryAfterSeconds) ? Math.max(0, result.retryAfterSeconds!) : 0;
      notice.nextAttemptAt = now + Math.max(serverDelay, Math.min(3600, 2 ** Math.min(notice.attempts, 12))) * 1000;
    }
    await save();
    // A rate limit applies to the bot, not just this message.
    if (!result.ok) break;
  }
}
