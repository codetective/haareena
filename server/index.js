// Live quiz server. One game at a time.
// Answers stay here; players only ever receive questions and options.
// Payouts go through the bounty-pot contract, signed by the `host` key.
import { execFile } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT ?? 8787);
const STELLAR = process.env.STELLAR_BIN ?? "stellar";
const NETWORK = process.env.STELLAR_NETWORK ?? "testnet";
const CONTRACT = process.env.POT_CONTRACT ?? "CA4SNVKYXGJSXYCJUIKOAFLJT63PZZQSTJIR2DXSPVQ3Z3ELEUS27FCP";
const HOST_KEY = process.env.HOST_KEY ?? "host"; // stellar CLI identity that signs `pay`
const HOST_TOKEN = process.env.HOST_TOKEN ?? randomBytes(6).toString("hex");
const SPLIT = [50, 30, 20]; // percent of the pot for 1st, 2nd, 3rd
const REVEAL_MS = 4000;

const quiz = JSON.parse(readFileSync(new URL("./questions.json", import.meta.url), "utf8"));
const ADDRESS = /^[GC][A-Z2-7]{55}$/;

// ---- stellar CLI ----
function cli(args, timeout = 90_000) {
  return new Promise((resolve, reject) => {
    execFile(STELLAR, args, { timeout }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim().split("\n").pop()));
      else resolve({ stdout: stdout.trim(), stderr });
    });
  });
}
const invoke = (fn, fnArgs, { send = true } = {}) =>
  cli([
    "contract", "invoke", "--id", CONTRACT, "--source", HOST_KEY, "--network", NETWORK,
    ...(send ? [] : ["--send=no"]), "--", fn, ...fnArgs,
  ]);

const hostAddress = (await cli(["keys", "address", HOST_KEY])).stdout;

// ---- game state ----
const game = {
  state: "idle", // idle → lobby → question → reveal → finished → paying → paid
  pot: null, // { id, amount, deadline }
  players: new Map(), // address → { name, address, score, ws, answered }
  index: -1,
  endsAt: 0,
  timer: null,
  payout: null, // { tx, winners }
};
let hostWs = null;
const clients = new Set();

const send = (ws, msg) => ws?.readyState === 1 && ws.send(JSON.stringify(msg));
const broadcast = (msg) => clients.forEach((ws) => send(ws, msg));
const leaderboard = () =>
  [...game.players.values()]
    .map(({ name, address, score }) => ({ name, address, score }))
    .sort((a, b) => b.score - a.score);
const snapshot = () => ({
  t: "state",
  state: game.state,
  title: quiz.title,
  pot: game.pot,
  players: leaderboard(),
  question: game.state === "question" || game.state === "reveal" ? publicQuestion() : null,
  payout: game.payout,
});
const publicQuestion = () => {
  const { q, options } = quiz.questions[game.index];
  return { i: game.index, total: quiz.questions.length, q, options, endsAt: game.endsAt };
};

function nextQuestion() {
  game.index += 1;
  if (game.index >= quiz.questions.length) {
    game.state = "finished";
    return broadcast(snapshot());
  }
  game.state = "question";
  game.endsAt = Date.now() + quiz.secondsPerQuestion * 1000;
  for (const p of game.players.values()) p.answered = false;
  broadcast(snapshot());
  game.timer = setTimeout(reveal, quiz.secondsPerQuestion * 1000);
}

function reveal() {
  clearTimeout(game.timer);
  if (game.state !== "question") return;
  game.state = "reveal";
  broadcast({ ...snapshot(), answer: quiz.questions[game.index].answer });
  game.timer = setTimeout(nextQuestion, REVEAL_MS);
}

// ---- handlers ----
async function onHost(ws, { token, potId }) {
  const a = Buffer.from(String(token ?? ""));
  const b = Buffer.from(HOST_TOKEN);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error("wrong host token");
  if (!["idle", "lobby"].includes(game.state)) {
    // A host who dropped mid-game reconnects to the same game, so payout is never blocked.
    hostWs = ws;
    ws.role = "host";
    return send(ws, snapshot());
  }
  if (!Number.isSafeInteger(potId) || potId < 0 || potId > 0xffff_ffff) {
    throw new Error("pot id must be an integer between 0 and 4294967295");
  }

  // Same checks `pay` makes on chain, so the payout can't fail for these reasons later.
  const pot = JSON.parse((await invoke("get", ["--id", String(potId)], { send: false })).stdout.split("\n").pop());
  if (!pot.open) throw new Error(`pot ${potId} is already closed`);
  if (pot.host !== hostAddress) throw new Error(`pot ${potId} names a different host`);
  if (pot.deadline * 1000 <= Date.now() + 10 * 60_000) throw new Error(`pot ${potId} ends in under 10 minutes`);

  hostWs = ws;
  ws.role = "host";
  game.pot = { id: potId, amount: pot.amount, deadline: pot.deadline };
  game.state = "lobby";
  broadcast(snapshot());
}

function onJoin(ws, { name, address }) {
  if (ws.role === "host") throw new Error("the host can't play");
  if (game.state === "idle") throw new Error("the host hasn't opened a game yet");
  if (game.state !== "lobby" && !game.players.has(address)) throw new Error("this game has already started");
  name = String(name ?? "").trim().slice(0, 24);
  if (!name) throw new Error("enter a name");
  if (!ADDRESS.test(String(address ?? ""))) throw new Error("that is not a Stellar address");
  if (address === hostAddress) throw new Error("the host can't play");

  // Rejoining with the same address keeps the score and moves to the new connection.
  const existing = game.players.get(address);
  if (existing?.ws && existing.ws !== ws) existing.ws.close();
  const player = existing ?? { name, address, score: 0, answered: false };
  player.ws = ws;
  ws.role = "player";
  ws.address = address;
  game.players.set(address, player);
  broadcast(snapshot());
}

function onAnswer(ws, { choice }) {
  const p = game.players.get(ws.address);
  if (!p || p.ws !== ws || game.state !== "question" || p.answered) return;
  const now = Date.now();
  if (now > game.endsAt) return;
  p.answered = true;
  const q = quiz.questions[game.index];
  if (choice === q.answer) {
    const left = (game.endsAt - now) / (quiz.secondsPerQuestion * 1000);
    p.score += 500 + Math.round(500 * left);
  }
  send(ws, { t: "answered" });
  if ([...game.players.values()].every((x) => x.answered || x.ws?.readyState !== 1)) reveal();
}

async function onPay() {
  if (game.state !== "finished") throw new Error("finish the quiz before paying");
  const winners = leaderboard().filter((p) => p.score > 0).slice(0, SPLIT.length);
  if (!winners.length) throw new Error("nobody scored, so there is nobody to pay");

  const amount = BigInt(game.pot.amount);
  const payouts = winners.map((w, i) => ({ to: w.address, amount: ((amount * BigInt(SPLIT[i])) / 100n).toString() }));

  game.state = "paying"; // set before awaiting, so a second click is refused
  broadcast(snapshot());
  try {
    const { stdout, stderr } = await invoke("pay", ["--id", String(game.pot.id), "--winners", JSON.stringify(payouts)]);
    const tx = `${stdout}\n${stderr}`.match(/\/tx\/([0-9a-f]{64})/)?.[1] ?? null;
    game.payout = { tx, winners: payouts.map((p, i) => ({ ...p, name: winners[i].name })) };
    game.state = "paid";
  } catch (err) {
    // A failed payout must not lock the game. The contract refuses a second payment,
    // so retrying after a timeout that actually succeeded is safe.
    game.state = "finished";
    broadcast(snapshot());
    throw new Error(`payout failed: ${err.message}`);
  }
  broadcast(snapshot());
}

// ---- server ----
const wss = new WebSocketServer({ port: PORT, maxPayload: 4096 });
wss.on("connection", (ws) => {
  clients.add(ws);
  send(ws, snapshot());
  ws.on("message", async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      const isHost = ws.role === "host" && ws === hostWs;
      switch (msg.t) {
        case "host": return await onHost(ws, msg);
        case "join": return onJoin(ws, msg);
        case "answer": return onAnswer(ws, msg);
        case "start":
          if (!isHost) throw new Error("only the host can start");
          if (game.state !== "lobby") throw new Error("the game isn't in the lobby");
          if (!game.players.size) throw new Error("wait for at least one player");
          return nextQuestion();
        case "pay":
          if (!isHost) throw new Error("only the host can pay");
          return await onPay();
        case "leave":
          // Only before the quiz starts. The pot is untouched; the money is returned on chain after its deadline.
          if (!isHost) throw new Error("only the host can leave");
          if (game.state !== "lobby") throw new Error("the quiz has started, so it can't be cancelled");
          game.state = "idle";
          game.pot = null;
          game.players.clear();
          game.index = -1;
          game.payout = null;
          hostWs = null;
          ws.role = undefined;
          return broadcast(snapshot());
        default:
          throw new Error("unknown message");
      }
    } catch (err) {
      send(ws, { t: "error", msg: err instanceof SyntaxError ? "bad message" : err.message });
    }
  });
  ws.on("close", () => {
    clients.delete(ws);
    if (ws === hostWs) hostWs = null;
    else if (ws.role === "player") broadcast(snapshot());
  });
});

console.log(`Quiz server on ws://localhost:${PORT}`);
console.log(`Host key ${HOST_KEY} = ${hostAddress}`);
console.log(`Host token: ${HOST_TOKEN}`);
