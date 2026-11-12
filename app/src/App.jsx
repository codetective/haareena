import { useCallback, useEffect, useRef, useState } from "react";
import { usePollar } from "@pollar/react";

const WS_PROTOCOL = location.protocol === "https:" ? "wss:" : "ws:";
const WS_URL = import.meta.env.VITE_WS_URL ?? `${WS_PROTOCOL}//${location.hostname}:8787`;
const EXPLORER = "https://stellar.expert/explorer/testnet/tx/";
const ADDRESS = /^[GC][A-Z2-7]{55}$/;
const MAX_POT_ID = 0xffff_ffff;
const isHostUrl = () => location.hash === "#host";
const xlm = (stroops) => (Number(stroops) / 1e7).toLocaleString(undefined, { maximumFractionDigits: 2 });
const short = (a) => `${a.slice(0, 4)}…${a.slice(-4)}`;

// One connection to the game server, kept while switching between page and projector view.
// `onOpen` re-sends whatever joins this screen after every (re)connect.
function useGame(onOpen) {
  const [game, setGame] = useState(null);
  const [error, setError] = useState("");
  const [connected, setConnected] = useState(false);
  const ws = useRef(null);
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;

  useEffect(() => {
    let stopped = false;
    let retry;
    const open = () => {
      const sock = new WebSocket(WS_URL);
      ws.current = sock;
      sock.onopen = () => {
        setConnected(true);
        onOpenRef.current?.((m) => sock.send(JSON.stringify(m)));
      };
      sock.onclose = () => {
        setConnected(false);
        if (!stopped) retry = setTimeout(open, 1500);
      };
      sock.onmessage = (e) => {
        let d;
        try {
          d = JSON.parse(e.data);
        } catch {
          return;
        }
        if (d.t === "state") {
          setGame(d);
          setError("");
        } else if (d.t === "error") setError(d.msg);
      };
    };
    open();
    return () => {
      stopped = true;
      clearTimeout(retry);
      ws.current?.close();
    };
  }, []);

  const send = useCallback((m) => {
    if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify(m));
    else setError("Not connected to the game server yet");
  }, []);
  return { game, error, connected, send };
}

function useNow(active) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

export default function App({ pollar, pollarNotice }) {
  const [isHost, setIsHost] = useState(isHostUrl);
  useEffect(() => {
    const f = () => setIsHost(isHostUrl());
    window.addEventListener("hashchange", f);
    return () => window.removeEventListener("hashchange", f);
  }, []);

  const joined = useRef(null); // { name, address } of this player
  const hosting = useRef(null); // { token, potId } of this host
  const { game, error, connected, send } = useGame((raw) => {
    if (hosting.current) raw({ t: "host", ...hosting.current });
    else if (joined.current) raw({ t: "join", ...joined.current });
  });

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#player" aria-label="Haareena home">
          <img src="/haareena-mark.svg" alt="" width="42" height="42" />
          <span>Haareena</span>
        </a>
        <div className="topbar-actions">
          <span className="tag"><span className="tag-dot" />Stellar testnet</span>
          <a className="mode-link" href={isHost ? "#player" : "#host"}>
            {isHost ? "Back to game" : "Host a round"}
          </a>
        </div>
      </header>
      {game === null ? (
        <Status connected={connected} />
      ) : isHost ? (
        <Host game={game} send={send} hosting={hosting} playing={Boolean(joined.current)} error={error} />
      ) : game.state === "idle" ? (
        <Status connected={connected} waitingForHost />
      ) : (
        <Player pollar={pollar} pollarNotice={pollarNotice} game={game} send={send} joined={joined} error={error} />
      )}
      <footer className="app-footer">A quick quiz arena on Stellar testnet</footer>
    </main>
  );
}

// ---------- player ----------
function Player({ pollar, pollarNotice, game, send, joined, error }) {
  const [name, setName] = useState(joined.current?.name ?? "");
  const [address, setAddress] = useState(joined.current?.address ?? "");
  const [picked, setPicked] = useState(null);
  const qIndex = game.question?.i;
  useEffect(() => setPicked(null), [qIndex]);
  const now = useNow(game.state === "question");
  const onAddress = useCallback((a) => setAddress(a), []);

  const me = game.players.find((p) => p.address === address.trim());
  const join = (e) => {
    e.preventDefault();
    const alreadyJoined = game.players.some((player) => player.address === address.trim());
    if (!name.trim() || !ADDRESS.test(address.trim()) || (game.state !== "lobby" && !alreadyJoined)) return;
    joined.current = { name: name.trim(), address: address.trim() };
    send({ t: "join", ...joined.current });
  };

  if (!me) {
    const valid = name.trim() && ADDRESS.test(address.trim());
    const alreadyJoined = game.players.some((player) => player.address === address.trim());
    const canSubmit = valid && (game.state === "lobby" || alreadyJoined);
    return (
      <section className="stack">
        <PotBanner game={game} />
        <form onSubmit={join} className="card stack join-card">
          <div className="section-heading">
            <span className="eyebrow">{game.state === "lobby" ? "PLAYER ENTRY" : "ROUND IN PROGRESS"}</span>
            <h2>{game.state === "lobby" ? "Take your place" : "Back in the game?"}</h2>
            <p className="muted">
              {game.state === "lobby"
                ? "Join the lobby before the host starts the first question."
                : "Only players who already joined can reconnect after a round starts."}
            </p>
          </div>
          {pollar ? <PollarLogin onAddress={onAddress} /> : pollarNotice && <p className="muted wallet-note">{pollarNotice}</p>}
          <label>
            Your name
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={24} placeholder="Ada" autoComplete="nickname" />
          </label>
          <label>
            Stellar address <span className="label-hint">prizes are paid here</span>
            <input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="G…"
              spellCheck={false}
              autoComplete="off"
            />
          </label>
          <button disabled={!canSubmit}>{game.state === "lobby" ? "Join game" : "Reconnect"}</button>
          <ErrorLine error={error} />
        </form>
        <Board game={game} />
      </section>
    );
  }

  return (
    <section className="stack">
      <PotBanner game={game} />
      {game.state === "lobby" && <p className="card center">You're in, {me.name}. Waiting for the host to start…</p>}
      {(game.state === "question" || game.state === "reveal") && (
        <Question
          game={game}
          now={now}
          picked={picked}
          onPick={(i) => {
            if (picked !== null || game.state !== "question") return;
            setPicked(i);
            send({ t: "answer", choice: i });
          }}
        />
      )}
      <Board game={game} highlight={me.address} />
      <ErrorLine error={error} />
    </section>
  );
}

function PollarLogin({ onAddress }) {
  const { isAuthenticated, wallet, login } = usePollar();
  const [loginPending, setLoginPending] = useState(false);
  const [loginError, setLoginError] = useState("");
  useEffect(() => {
    if (wallet?.address) onAddress(wallet.address);
  }, [wallet?.address, onAddress]);
  const continueWithGoogle = async () => {
    setLoginPending(true);
    setLoginError("");
    try {
      await login({ provider: "google" });
    } catch {
      setLoginError("Google sign-in failed. You can still paste a Stellar address below.");
    } finally {
      setLoginPending(false);
    }
  };
  if (!isAuthenticated)
    return (
      <div className="stack compact-stack">
        <button type="button" className="secondary" onClick={continueWithGoogle} disabled={loginPending}>
          {loginPending ? "Opening Google sign-in…" : "Continue with Google"}
        </button>
        <ErrorLine error={loginError} />
      </div>
    );
  if (!wallet || wallet.provisioning === "CREATING") return <p className="muted">Creating your wallet…</p>;
  if (!wallet.address) return <p className="muted" role="status">Wallet setup is incomplete. Paste a Stellar address below to continue.</p>;
  return <p className="muted">Wallet ready: {short(wallet.address)}</p>;
}

// ---------- host ----------
function Host({ game, send, hosting, playing, error }) {
  const [token, setToken] = useState("");
  const [potId, setPotId] = useState("");
  const now = useNow(game.state === "question");

  if (!hosting.current) {
    const open = (e) => {
      e.preventDefault();
      if (playing) return;
      hosting.current = { token: token.trim(), potId: Number(potId) };
      send({ t: "host", ...hosting.current });
    };
    return (
      <form onSubmit={open} className="card stack">
        <label>
          Host token (printed by the server)
          <input value={token} onChange={(e) => setToken(e.target.value)} spellCheck={false} autoComplete="off" />
        </label>
        <label>
          Pot id
          <input value={potId} onChange={(e) => setPotId(e.target.value)} inputMode="numeric" maxLength={10} placeholder="2" />
        </label>
        <button disabled={playing || !token.trim() || !/^\d+$/.test(potId) || Number(potId) > MAX_POT_ID}>
          {playing ? "You're playing in this tab. Use another tab to host." : "Open game"}
        </button>
        <ErrorLine error={error} />
      </form>
    );
  }

  const leave = () => {
    hosting.current = null;
    send({ t: "leave" });
  };

  return (
    <section className="stack">
      <PotBanner game={game} />
      {game.state === "lobby" && (
        <div className="card stack center">
          <p>
            Players join at <strong>{location.host}</strong>
          </p>
          <button disabled={!game.players.length} onClick={() => send({ t: "start" })}>
            Start quiz ({game.players.length} {game.players.length === 1 ? "player" : "players"})
          </button>
          <button className="secondary" onClick={leave}>Cancel this round</button>
          <p className="muted host-note">
            This closes the lobby only. The pot stays locked until its deadline; the sponsor can refund it after.
          </p>
        </div>
      )}
      {(game.state === "question" || game.state === "reveal") && <Question game={game} now={now} />}
      {(game.state === "finished" || game.state === "paying") && (
        <button disabled={game.state === "paying"} onClick={() => send({ t: "pay" })}>
          {game.state === "paying" ? "Paying winners on testnet…" : "Pay the top 3"}
        </button>
      )}
      <Board game={game} />
      <ErrorLine error={error} />
    </section>
  );
}

// ---------- shared ----------
function Status({ connected, waitingForHost = false }) {
  const title = waitingForHost ? "Your next round starts here." : connected ? "Getting the arena ready." : "Finding the game server.";
  const message = waitingForHost
    ? "The host is setting up the next quiz. This screen will update as soon as the lobby opens."
    : connected
      ? "Loading your game and checking the live lobby…"
      : "Reconnecting now. Keep this page open and we’ll bring you back in.";

  return (
    <section className="splash-card" aria-busy={!waitingForHost}>
      <div className="splash-shade" />
      <div className="splash-copy">
        <span className="eyebrow"><span className="live-dot" />{waitingForHost ? "WAITING ROOM" : connected ? "STARTING UP" : "RECONNECTING"}</span>
        <h1>{title}</h1>
        <p>{message}</p>
        <div className="loading-status" role="status" aria-live="polite">
          <span className={waitingForHost ? "loading-dots" : "spinner"} aria-hidden="true">
            {waitingForHost && <><i /><i /><i /></>}
          </span>
          <span>{waitingForHost ? "Waiting for the host to open a round" : connected ? "Loading game…" : "Trying again…"}</span>
        </div>
      </div>
    </section>
  );
}

function ErrorLine({ error }) {
  return error ? (
    <p className="error" role="alert">
      {error}
    </p>
  ) : null;
}

function PotBanner({ game }) {
  if (!game.pot) return <p className="muted center">Waiting for the host to open a game…</p>;
  return (
    <div className="pot">
      <span>{game.title}</span>
      <strong>{xlm(game.pot.amount)} XLM bounty</strong>
    </div>
  );
}

function Question({ game, now, picked, onPick }) {
  const q = game.question;
  if (!q) return null;
  const left = Math.max(0, Math.ceil((q.endsAt - now) / 1000));
  return (
    <div className="card stack question-card">
      <div className="row">
        <span className="muted">
          Question {q.i + 1} of {q.total}
        </span>
        {game.state === "question" && <span className="timer">{left}s</span>}
      </div>
      <h2>{q.q}</h2>
      <div className="options">
        {q.options.map((o, i) => {
          const cls = [
            "option",
            game.state === "question" && picked === i && "picked",
            game.state === "reveal" && game.answer === i && "correct",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <button
              key={i}
              className={cls}
              disabled={game.state !== "question" || (onPick && picked !== null)}
              onClick={() => onPick?.(i)}
            >
              {o}
            </button>
          );
        })}
      </div>
      {picked !== null && game.state === "question" && <p className="muted center">Answer locked in</p>}
      {game.state === "reveal" && <p className="center">The answer is highlighted in green</p>}
    </div>
  );
}

function Board({ game, highlight }) {
  const paid = game.payout;
  return (
    <div className="card stack">
      <h3>{game.state === "paid" ? "Winners paid" : "Leaderboard"}</h3>
      {game.players.length === 0 && <p className="muted">No players yet</p>}
      <ol className="board">
        {game.players.map((p, i) => {
          const win = paid?.winners.find((w) => w.to === p.address);
          return (
            <li key={p.address} className={p.address === highlight ? "me" : ""}>
              <span className="rank">{i + 1}</span>
              <span className="name">{p.name}</span>
              <span className="score">{win ? `+${xlm(win.amount)} XLM` : p.score}</span>
            </li>
          );
        })}
      </ol>
      {paid?.tx && (
        <a href={EXPLORER + paid.tx} target="_blank" rel="noreferrer">
          See the payout on Stellar Expert ↗
        </a>
      )}
    </div>
  );
}
