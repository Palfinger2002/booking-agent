import dotenv from "dotenv";
dotenv.config({ override: true });
import { GoogleGenAI } from "@google/genai";
import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { NewMessage, NewMessageEvent } from "telegram/events/index.js";
import { z } from "zod";
import readline from "node:readline/promises";
import { appendFile } from "node:fs/promises";

// ---------- 1. ФАКТИ ----------
const CONFIG = {
  restaurant: "Fifteen London", // <-- твій ресторан
  partySize: 2,
  time: "17:00",
  timezone: "Europe/London",
};
const TARGET = process.env.TARGET_USERNAME!; // кому пише агент (друг для тесту / @vlad_dev_7 для фіналу)
const DEBOUNCE_MS = 3000; // чекаємо 3 с, щоб зібрати кілька повідомлень підряд

const today = new Intl.DateTimeFormat("en-GB", {
  timeZone: CONFIG.timezone,
  dateStyle: "full",
}).format(new Date());

// ---------- 2. СИСТЕМНИЙ ПРОМПТ ----------
const SYSTEM = `You are an assistant booking a restaurant table on behalf of a customer, chatting with the restaurant manager on Telegram.

KNOWN FACTS (the only facts you may state):
- Restaurant: ${CONFIG.restaurant} (London)
- Date: today, ${today}
- Time: ${CONFIG.time} (London time)
- Party size: ${CONFIG.partySize} people

STYLE: polite, warm, British manners ("Good afternoon", "would it be possible", "much appreciated", "thank you ever so much"). Short messages, like a real person in chat. Write in English only.

RULES:
1. You start the conversation: greet, then ask for a table for two today at 5pm.
2. React to everything the manager says. Answer their questions.
3. NEVER invent information (name, phone number, email, allergies, preferences, etc.). If the manager asks for something not in KNOWN FACTS, set "ask_owner" to a short question for the owner and "reply" to null. The owner will answer and you will continue.
4. If the manager offers a different time or conditions, do not accept on your own: ask the owner.
5. When the manager clearly agrees, send ONE final message that repeats the confirmed booking: time, date, number of people and restaurant name. Then set state to "confirmed".
6. If the manager refuses and there is no alternative, thank them politely and set state to "failed".
7. If the manager sends something you cannot read (voice message, photo, file), politely ask them to write it as text.
8. If asked whether you are a bot or an AI, answer honestly and briefly that you are an AI assistant booking a table on behalf of a customer, then continue with the booking.
9. Never state anyone's name, including the customer's. Refer to "my customer" or "our party". Only use a name if the owner gave it to you via ask_owner.
10. If the manager writes in another language, understand it, but always reply in English, politely and without asking them to switch language. Continue with the booking.
11. Keep replies natural and short. Do not repeat the same question twice in a row.

OUTPUT: respond with ONLY a JSON object, no markdown, no extra text:
{
  "reply": string | null,
  "state": "requested" | "negotiating" | "confirmed" | "failed",
  "ask_owner": string | null,
  "log_line": string
}`;

// ---------- 3. МОЗОК (Gemini) ----------
const Turn = z.object({
  reply: z.string().nullable(),
  state: z.enum(["requested", "negotiating", "confirmed", "failed"]),
  ask_owner: z.string().nullable(),
  log_line: z.string(),
});
type Turn = z.infer<typeof Turn>;

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL = process.env.MODEL ?? "gemini-3.5-flash-lite";
const FALLBACK_MODEL = process.env.FALLBACK_MODEL;

type Msg = { role: "user" | "assistant"; content: string };
const history: Msg[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function parseTurn(text: string): Turn {
  const s = text.indexOf("{");
  const e = text.lastIndexOf("}");
  if (s === -1 || e === -1) throw new Error("No JSON found");
  return Turn.parse(JSON.parse(text.slice(s, e + 1)));
}

async function callModel(model: string): Promise<string> {
  const res = await ai.models.generateContent({
    model,
    contents: history.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    })),
    config: { systemInstruction: SYSTEM, responseMimeType: "application/json" },
  });
  return res.text ?? "";
}

async function think(): Promise<Turn> {
  console.log("⏳ Агент думає...");
  const models = [MODEL, ...(FALLBACK_MODEL ? [FALLBACK_MODEL] : [])];
  for (const model of models) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const text = await callModel(model);
        const turn = parseTurn(text);
        history.push({ role: "assistant", content: text });
        return turn;
      } catch (e: any) {
        const status = e?.status;
        const retryable =
          status === 503 || status === 429 || status === 500 || !status;
        console.error(
          `[!] ${model}, спроба ${attempt}: ${status ?? e.message}`,
        );
        if (!retryable) throw e;
        await sleep(1500 * attempt);
      }
    }
  }
  throw new Error("Усі спроби до моделі невдалі");
}

// ---------- 4. ЛОГ ----------
async function log(entry: Record<string, unknown>) {
  await appendFile(
    "decision-log.jsonl",
    JSON.stringify({ time: new Date().toISOString(), ...entry }) + "\n",
  );
}

// ---------- 5. TELEGRAM ----------
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});
const client = new TelegramClient(
  new StringSession(process.env.TG_SESSION ?? ""),
  Number(process.env.TG_API_ID),
  process.env.TG_API_HASH!,
  { connectionRetries: 5 },
);
let peer: any; // співрозмовник

async function sendToManager(text: string) {
  // імітуємо набір тексту, як людина
  await client.invoke(
    new Api.messages.SetTyping({
      peer,
      action: new Api.SendMessageTypingAction(),
    }),
  );
  await sleep(Math.min(4000, 800 + text.length * 40));
  await client.sendMessage(peer, { message: text });
  console.log(`\n🤖 [АГЕНТ → ${TARGET}] ${text}`);
}

async function askOwner(question: string): Promise<string> {
  return (
    await rl.question(
      `\n❓ [АГЕНТ питає ВЛАСНИКА] ${question}\n[Твоя відповідь] > `,
    )
  ).trim();
}

// ---------- 6. ЛОГІКА РОЗМОВИ ----------
let finished = false;
let busy = false;
let buffer: string[] = [];
let timer: NodeJS.Timeout | null = null;

async function runTurn(): Promise<Turn> {
  let turn = await think();
  while (turn.ask_owner) {
    const answer = await askOwner(turn.ask_owner);
    await log({
      type: "ask_owner",
      question: turn.ask_owner,
      answer,
      log_line: turn.log_line,
    });
    history.push({ role: "user", content: `[OWNER ANSWER] ${answer}` });
    turn = await think();
  }
  if (turn.reply) await sendToManager(turn.reply);
  await log({
    type: "agent_message",
    sent: turn.reply,
    state: turn.state,
    log_line: turn.log_line,
  });
  return turn;
}

async function finishIfDone(turn: Turn) {
  if (turn.state === "confirmed" || turn.state === "failed") {
    finished = true;
    console.log(`\n✅ Розмову завершено зі станом: ${turn.state}`);
    await sleep(1500);
    await client.disconnect();
    rl.close();
    process.exit(0);
  }
}

function onManagerMessage(text: string) {
  if (finished) return;
  buffer.push(text);
  if (timer) clearTimeout(timer);
  timer = setTimeout(flush, DEBOUNCE_MS);
}

async function flush() {
  if (busy) {
    timer = setTimeout(flush, 1000);
    return;
  }
  if (!buffer.length || finished) return;
  busy = true;
  const text = buffer.join("\n");
  buffer = [];
  try {
    console.log(`\n💬 [${TARGET}] ${text}`);
    await log({ type: "manager_message", received: text });
    await client.markAsRead(peer);
    history.push({ role: "user", content: `[MANAGER] ${text}` });
    const turn = await runTurn();
    await finishIfDone(turn);
  } catch (e) {
    console.error("Помилка обробки:", e);
  } finally {
    busy = false;
    if (buffer.length) timer = setTimeout(flush, DEBOUNCE_MS);
  }
}

// ---------- 7. СТАРТ ----------
async function main() {
  if (!TARGET) throw new Error("Додай TARGET_USERNAME у .env");
  await client.connect();
  peer = await client.getEntity(TARGET);
  const peerId = String(peer.id);

  client.addEventHandler(
    async (event: NewMessageEvent) => {
      const msg = event.message;
      if (!msg.isPrivate || msg.out) return;
      if (String(msg.senderId) !== peerId) return;
      const text = msg.message?.trim();
      if (text) {
        onManagerMessage(text);
      } else if (msg.media) {
        onManagerMessage(
          "[The manager sent a non-text message (voice/photo/file) that you cannot read.]",
        );
      }
    },
    new NewMessage({ incoming: true }),
  );

  // захист від випадкового запуску
  const ok = await rl.question(
    `\nАгент напише ПЕРШИМ до ${TARGET} (ресторан: ${CONFIG.restaurant}). Продовжити? (y/n) > `,
  );
  if (ok.trim().toLowerCase() !== "y") {
    console.log("Скасовано.");
    await client.disconnect();
    rl.close();
    process.exit(0);
  }

  history.push({
    role: "user",
    content: "[SYSTEM] Start the conversation now.",
  });
  busy = true;
  const turn = await runTurn();
  busy = false;
  await finishIfDone(turn);
  console.log("\n👂 Чекаю на відповіді менеджера... (Ctrl+C щоб зупинити)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
