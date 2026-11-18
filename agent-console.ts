import dotenv from "dotenv";
dotenv.config({ override: true });
import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import readline from "node:readline/promises";
import { appendFile } from "node:fs/promises";

// ---------- 1. ФАКТИ, які агент знає заздалегідь ----------
const CONFIG = {
  restaurant: "Fifteen London", // <-- ЗАМІНИ на реальний ресторан у Лондоні
  partySize: 2,
  time: "17:00",
  timezone: "Europe/London",
};

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

OUTPUT: respond with ONLY a JSON object, no markdown, no extra text:
{
  "reply": string | null,        // message to send to the manager
  "state": "requested" | "negotiating" | "confirmed" | "failed",
  "ask_owner": string | null,    // question for the owner, or null
  "log_line": string             // one line: what you understood and decided
}`;

// ---------- 3. ВАЛІДАЦІЯ ВІДПОВІДІ МОДЕЛІ ----------
const Turn = z.object({
  reply: z.string().nullable(),
  state: z.enum(["requested", "negotiating", "confirmed", "failed"]),
  ask_owner: z.string().nullable(),
  log_line: z.string(),
});
type Turn = z.infer<typeof Turn>;

if (!process.env.GEMINI_API_KEY) {
  console.error("Немає GEMINI_API_KEY у файлі .env");
  process.exit(1);
}
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL = process.env.MODEL ?? "gemini-2.5-flash";

type Msg = { role: "user" | "assistant"; content: string };
const history: Msg[] = [];

function parseTurn(text: string): Turn {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON found");
  return Turn.parse(JSON.parse(text.slice(start, end + 1)));
}

const FALLBACK_MODEL = process.env.FALLBACK_MODEL; // необов'язково

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function callModel(model: string): Promise<string> {
  const res = await ai.models.generateContent({
    model,
    contents: history.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    })),
    config: {
      systemInstruction: SYSTEM,
      responseMimeType: "application/json",
    },
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
        await sleep(2000 * attempt); // 2с, 4с, 6с, 8с, 10с
      }
    }
  }
  throw new Error("Усі спроби до моделі невдалі");
}

// ---------- 4. ЛОГ РІШЕНЬ ----------
async function log(entry: Record<string, unknown>) {
  await appendFile(
    "decision-log.jsonl",
    JSON.stringify({ time: new Date().toISOString(), ...entry }) + "\n",
  );
}

// ---------- 5. ІНТЕРФЕЙС (консоль). У версії з Telegram замінимо лише це ----------
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

async function receiveFromManager(): Promise<string> {
  return (await rl.question("\n[МЕНЕДЖЕР пише] > ")).trim();
}
async function askOwner(question: string): Promise<string> {
  return (
    await rl.question(
      `\n❓ [АГЕНТ питає ВЛАСНИКА] ${question}\n[Твоя відповідь] > `,
    )
  ).trim();
}
async function sendToManager(text: string) {
  console.log(`\n🤖 [АГЕНТ → менеджеру] ${text}`);
}

// ---------- 6. ГОЛОВНИЙ ЦИКЛ ----------
async function runTurn(): Promise<Turn> {
  let turn = await think();

  // Якщо агенту бракує даних, питає власника, потім думає ще раз
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

async function main() {
  // Агент починає розмову першим
  history.push({
    role: "user",
    content: "[SYSTEM] Start the conversation now.",
  });
  let turn = await runTurn();

  while (turn.state !== "confirmed" && turn.state !== "failed") {
    const managerText = await receiveFromManager();
    await log({ type: "manager_message", received: managerText });
    history.push({ role: "user", content: `[MANAGER] ${managerText}` });
    turn = await runTurn();
  }

  console.log(`\n✅ Розмову завершено зі станом: ${turn.state}`);
  rl.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
