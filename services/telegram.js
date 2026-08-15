const fetch = require('node-fetch');

function createTelegramService({ config, log }) {
  async function sendTelegram(message) {
    if (
      config.TELEGRAM_ENABLED === false ||
      !config.TELEGRAM_BOT_TOKEN ||
      !config.TELEGRAM_CHAT_ID
    ) {
      return;
    }

    try {
      const response = await fetch(
        `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            chat_id: config.TELEGRAM_CHAT_ID,
            text: message,
            parse_mode: 'HTML',
          }),
        }
      );

      if (!response.ok) {
        const text = await response.text();

        throw new Error(
          `Telegram HTTP ${response.status}: ${text}`
        );
      }
    } catch (error) {
      log(
        `Telegram send failed: ${error.message}`
      );
    }
  }

  return {
    sendTelegram,
  };
}

module.exports = {
  createTelegramService,
};