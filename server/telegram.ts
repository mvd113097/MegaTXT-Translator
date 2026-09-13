import dotenv from "dotenv";

dotenv.config();

/**
 * Sends a notification message to all configured Telegram chat IDs.
 * Resolves once all notifications have been dispatched to ensure logs & process exits complete reliably.
 */
export async function sendTelegramNotification(message: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatIdsStr = process.env.TELEGRAM_CHAT_IDS;

  if (!token || !chatIdsStr) {
    // If not configured, silently skip
    return;
  }

  const chatIds = chatIdsStr
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);

  if (chatIds.length === 0) {
    return;
  }

  const formattedMessage = encodeURIComponent(message);

  const promises = chatIds.map((chatId) => {
    const url = `https://api.telegram.org/bot${token}/sendMessage?chat_id=${chatId}&text=${formattedMessage}&parse_mode=HTML`;
    return fetch(url)
      .then((res) => {
        if (!res.ok) {
          console.error(`[Telegram] Failed to send to ${chatId}: HTTP ${res.status}`);
        }
      })
      .catch((err) => {
        console.error(`[Telegram] Network error sending to ${chatId}:`, err.message || err);
      });
  });

  await Promise.all(promises);
}
