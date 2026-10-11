// Telegram Bot API sender.
// Uses the process-global undici dispatcher set up in binance.ts, so the same
// PROXY / HTTP(S)_PROXY routing that reaches fapi.binance.com also reaches
// api.telegram.org (both are blocked in some regions — one proxy serves both).

export interface TelegramSendResult {
  ok: boolean;
  /** Human-readable failure reason; undefined on success. */
  error?: string;
}

export function telegramConfigured(): boolean {
  const token = process.env.TELEGRAM_BOT_TOKEN ?? "";
  const chatId = process.env.TELEGRAM_CHAT_ID ?? "";
  return token.trim() !== "" && chatId.trim() !== "";
}

/** One-shot sendMessage. Never throws — failures come back as { ok:false, error }. */
export async function sendTelegramMessage(text: string): Promise<TelegramSendResult> {
  const apiBase = process.env.TELEGRAM_API_BASE ?? "https://api.telegram.org";
  const botToken = process.env.TELEGRAM_BOT_TOKEN ?? "";
  const chatId = process.env.TELEGRAM_CHAT_ID ?? "";

  if (botToken.trim() === "" || chatId.trim() === "") {
    return { ok: false, error: "TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID 未配置（.env）" };
  }
  try {
    const res = await fetch(`${apiBase}/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, error: `Telegram HTTP ${res.status}: ${body.slice(0, 300)}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `Telegram 请求失败: ${e instanceof Error ? e.message : String(e)}` };
  }
}
