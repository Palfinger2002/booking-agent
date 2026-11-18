import dotenv from "dotenv";
dotenv.config({ override: true });
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import readline from "node:readline/promises";

async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const apiId = Number(process.env.TG_API_ID);
  const apiHash = process.env.TG_API_HASH;
  if (!apiId || !apiHash) {
    console.error("Додай TG_API_ID і TG_API_HASH у .env");
    process.exit(1);
  }

  const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () =>
      (await rl.question("Номер телефону (з +380...): ")).trim(),
    phoneCode: async () =>
      (await rl.question("Код (приходить у застосунок Telegram): ")).trim(),
    password: async () =>
      (await rl.question("Пароль 2FA (якщо немає, натисни Enter): ")).trim(),
    onError: (err) => console.error("Помилка входу:", err),
  });

  console.log(
    "\n✅ Успішний вхід. Скопіюй цей рядок у .env як TG_SESSION=...\n",
  );
  console.log(client.session.save());

  await client.disconnect();
  rl.close();
  process.exit(0);
}

main();
