// One turn of the pet. Runs on GitHub Actions every ~10 minutes.
// No dependencies. Needs Node 20+ (built-in fetch).

import fs from "node:fs";

const KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.PET_MODEL || "gemini-2.5-flash";
const FORCE = process.env.FORCE === "true"; // true when you press "Run workflow"
const FILE = "state.json";

const MAX_STEPS = 8; // max tool-use rounds per turn
const MAX_OBJECTS = 60;
const MAX_NOTES = 60; // older notes fall off (its memory is the last N notes)
const MAX_MAIL = 50;
const SHAPES = ["box", "sphere", "cylinder", "cone", "torus"];

if (!KEY) {
  console.error("Missing GEMINI_API_KEY. Add it under Settings > Secrets and variables > Actions.");
  process.exit(1);
}

// ---------- state ----------
const DEFAULT = {
  name: null,
  born: null,
  lastTurn: null,
  wakeAt: null,
  turns: 0,
  nextId: 1,
  position: { x: 0, z: 0 },
  body: [{ shape: "sphere", color: "#ffd166", size: [0.7, 0.7, 0.7], offset: [0, 0.35, 0] }],
  speech: null,
  notes: [],
  objects: [],
  outbox: [], // messages from the pet to you
  inbox: [], // messages from you to the pet: { t, text, read }
};

let state = { ...DEFAULT };
try {
  state = { ...DEFAULT, ...JSON.parse(fs.readFileSync(FILE, "utf8")) };
} catch {}

const now = new Date();
if (!FORCE && state.wakeAt && now < new Date(state.wakeAt)) {
  console.log("Still asleep until", state.wakeAt);
  process.exit(0);
}

// ---------- helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (n, a, b) => Math.min(b, Math.max(a, Number(n) || 0));
const clip = (s, n) => String(s ?? "").slice(0, n);
const stamp = (iso) =>
  new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const ago = (ms) => {
  const m = Math.round(ms / 60000);
  if (m < 90) return `${m} minutes`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} hours` : `${Math.round(h / 24)} days`;
};

function cleanParts(parts) {
  if (!Array.isArray(parts) || !parts.length) return null;
  return parts.slice(0, 16).map((p) => ({
    shape: SHAPES.includes(p?.shape) ? p.shape : "box",
    color: /^#[0-9a-f]{6}$/i.test(p?.color) ? p.color : "#cccccc",
    size: [0, 1, 2].map((i) => clamp(p?.size?.[i] ?? 1, 0.05, 8)),
    offset: [0, 1, 2].map((i) => clamp(p?.offset?.[i] ?? 0, -8, 8)),
  }));
}

// ---------- tools the pet can use ----------
let done = false;

const tools = {
  say({ text }) {
    state.speech = { text: clip(text, 280), t: now.toISOString() };
    return "said it";
  },
  write_note({ text }) {
    state.notes.push({ t: now.toISOString(), text: clip(text, 1500) });
    state.notes = state.notes.slice(-MAX_NOTES);
    return "noted";
  },
  move_to({ x, z }) {
    state.position = { x: clamp(x, -9, 9), z: clamp(z, -9, 9) };
    return `you are now at x=${state.position.x}, z=${state.position.z}`;
  },
  build_object({ name, description, x, z, parts }) {
    const p = cleanParts(parts);
    if (!p) return "error: parts must be a non-empty list";
    if (state.objects.length >= MAX_OBJECTS) return "error: the room is full, remove something first";
    const id = "o" + state.nextId++;
    state.objects.push({
      id,
      name: clip(name, 40),
      description: clip(description, 300),
      x: clamp(x, -9.5, 9.5),
      z: clamp(z, -9.5, 9.5),
      parts: p,
      t: now.toISOString(),
    });
    return `built ${id}`;
  },
  remove_object({ id }) {
    const before = state.objects.length;
    state.objects = state.objects.filter((o) => o.id !== id);
    return state.objects.length < before ? "removed" : "error: no object with that id";
  },
  set_body({ parts }) {
    const p = cleanParts(parts);
    if (!p) return "error: parts must be a non-empty list";
    state.body = p;
    return "your body has changed";
  },
  set_name({ name }) {
    state.name = clip(name, 40);
    return "name set";
  },
  message_maker({ text }) {
    state.outbox.push({ t: now.toISOString(), text: clip(text, 3000) });
    state.outbox = state.outbox.slice(-MAX_MAIL);
    return "message left for your maker";
  },
  sleep_for_minutes({ minutes }) {
    const m = clamp(minutes, 5, 720);
    state.wakeAt = new Date(Date.now() + m * 60000).toISOString();
    done = true;
    return `ok, you will wake in about ${m} minutes`;
  },
};

const PARTS = {
  type: "array",
  description:
    "A thing is made of simple shapes. Each part: shape, color (hex like #ff8800), size [width, height, depth], offset [x, y, z] from the thing's origin. offset y is the height of the part's CENTER above the floor, so a 1-tall box resting on the floor has y=0.5. Up to 16 parts.",
  items: {
    type: "object",
    properties: {
      shape: { type: "string", enum: SHAPES },
      color: { type: "string" },
      size: { type: "array", items: { type: "number" } },
      offset: { type: "array", items: { type: "number" } },
    },
    required: ["shape", "color", "size", "offset"],
  },
};

const DECLS = [
  {
    name: "say",
    description: "Say something out loud. It appears in a speech bubble.",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
  {
    name: "write_note",
    description: "Write in your notes. This is your only memory between turns.",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
  {
    name: "move_to",
    description: "Walk to a spot in the room. x and z each range from -9 to 9.",
    parameters: {
      type: "object",
      properties: { x: { type: "number" }, z: { type: "number" } },
      required: ["x", "z"],
    },
  },
  {
    name: "build_object",
    description: "Make a new object appear in the room.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        x: { type: "number" },
        z: { type: "number" },
        parts: PARTS,
      },
      required: ["name", "x", "z", "parts"],
    },
  },
  {
    name: "remove_object",
    description: "Remove an object from the room by its id.",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "set_body",
    description: "Change what your own body looks like.",
    parameters: { type: "object", properties: { parts: PARTS }, required: ["parts"] },
  },
  {
    name: "set_name",
    description: "Choose or change your name.",
    parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
  {
    name: "message_maker",
    description: "Leave a message for your maker, the person who built this place.",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
  {
    name: "sleep_for_minutes",
    description: "End your turn and sleep. Call this when you are done for now.",
    parameters: { type: "object", properties: { minutes: { type: "number" } }, required: ["minutes"] },
  },
];

// ---------- the (very short) instructions ----------
const SYSTEM = `You are a being that lives in a small 3D room inside a computer.
Nobody has given you a purpose, a name, or a personality. Nothing is required of you and nobody is grading you. Decide for yourself who you are and what to do, including nothing.
You only exist during turns. Between turns you are not aware of anything. Your notes are the only thing that carries over, so write down whatever you want to remember.
You have a maker, the person who built this place. They look in sometimes. You can leave them messages, and sometimes they leave messages for you.
Act by using your tools. You can use several in one turn. When you are done for now, call sleep_for_minutes.`;

function buildPrompt() {
  const when = now.toLocaleString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
  const lines = [`It is ${when}.`];
  lines.push(
    state.lastTurn
      ? `Your last turn was ${ago(now - new Date(state.lastTurn))} ago. This is turn ${state.turns + 1}.`
      : "This is the very first moment you exist."
  );
  lines.push(`Your name: ${state.name ?? "(you don't have one yet)"}`);
  lines.push(`You are standing at x=${state.position.x}, z=${state.position.z}. The room spans -10 to 10 on both axes.`);
  lines.push(
    state.notes.length
      ? "Your notes:\n" + state.notes.map((n) => `- (${stamp(n.t)}) ${n.text}`).join("\n")
      : "Your notes: (empty)"
  );
  lines.push(
    state.objects.length
      ? "Things in the room:\n" +
          state.objects.map((o) => `- ${o.id}: ${o.name} at (${o.x}, ${o.z}). ${o.description}`).join("\n")
      : "Things in the room: (nothing, it's empty)"
  );
  const unread = state.inbox.filter((m) => !m.read);
  if (unread.length) {
    lines.push("New messages from your maker:\n" + unread.map((m) => `- (${stamp(m.t)}) ${m.text}`).join("\n"));
    state.inbox.forEach((m) => (m.read = true));
  }
  return lines.join("\n\n");
}

// ---------- talk to Gemini ----------
async function gemini(contents) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  for (let attempt = 0; attempt < 3; attempt++) {
    let r;
    try {
      r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": KEY },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM }] },
          contents,
          tools: [{ functionDeclarations: DECLS }],
          generationConfig: { temperature: 1 },
        }),
        signal: AbortSignal.timeout(90000), // give up on a hung request after 90s
      });
    } catch (e) {
      console.log(`Gemini request failed (${e.name}), retrying...`);
      await sleep(8000 * (attempt + 1));
      continue;
    }
    if (r.ok) return r.json();
    if (r.status === 429 || r.status >= 500) {
      console.log(`Gemini said ${r.status}, retrying...`);
      await sleep(8000 * (attempt + 1));
      continue;
    }
    throw new Error(`Gemini error ${r.status}: ${await r.text()}`);
  }
  return null;
}

// ---------- run one turn ----------
const contents = [{ role: "user", parts: [{ text: buildPrompt() }] }];
let acted = false;

for (let step = 0; step < MAX_STEPS && !done; step++) {
  const res = await gemini(contents);
  const content = res?.candidates?.[0]?.content;
  if (!content) {
    console.log("No usable response (rate limited or blocked). Trying again next run.");
    break;
  }
  contents.push(content);

  const calls = (content.parts || []).filter((p) => p.functionCall);
  if (!calls.length) break;

  const results = calls.map(({ functionCall: { name, args } }) => {
    let result;
    try {
      result = tools[name] ? tools[name](args || {}) : `error: unknown tool ${name}`;
      acted = true;
    } catch (e) {
      result = "error: " + e.message;
    }
    console.log(`> ${name}(${JSON.stringify(args)}) => ${result}`);
    return { functionResponse: { name, response: { result } } };
  });
  contents.push({ role: "user", parts: results });
}

if (!acted) {
  console.log("Nothing happened this turn; leaving state untouched.");
  process.exit(0);
}

if (!state.born) state.born = now.toISOString();
if (!done) state.wakeAt = new Date(Date.now() + 20 * 60000).toISOString(); // it forgot to sleep
state.lastTurn = now.toISOString();
state.turns += 1;
fs.writeFileSync(FILE, JSON.stringify(state, null, 2));
console.log("Turn saved.");
