# Haareena — Quiz Arena

A live quiz where a sponsor's bounty is locked in a Stellar contract and paid to the winners when the round ends. Built at Boundless Build Day, Uyo (12 November 2026).

## The contract

| | |
|---|---|
| Network | testnet |
| Contract ID | `CA4SNVKYXGJSXYCJUIKOAFLJT63PZZQSTJIR2DXSPVQ3Z3ELEUS27FCP` |
| Explorer | [lab.stellar.org](https://lab.stellar.org/r/testnet/contract/CA4SNVKYXGJSXYCJUIKOAFLJT63PZZQSTJIR2DXSPVQ3Z3ELEUS27FCP) |
| Source | [`contracts/bounty-pot/src/lib.rs`](contracts/bounty-pot/src/lib.rs) |

One contract holds a **bounty pot** per game:

| Function | Who signs | What it does |
|---|---|---|
| `create(sponsor, host, token, amount, deadline)` | sponsor | Locks the prize in the contract, returns a pot id (0, 1, 2…) |
| `pay(id, winners)` | host | Pays every winner in one transaction before the deadline, sends any leftover back to the sponsor, closes the pot |
| `refund(id)` | sponsor | Returns the money after the deadline, only if nobody was paid |
| `get(id)` | anyone | Reads a pot's state |

Payout known good on testnet: [pot 6 payout](https://stellar.expert/explorer/testnet/tx/2a26496166fd6fcb1ee38a5b830a9695419c15ec46a897e520c9bcb348d1fdd9).

Build, test and deploy:

```bash
cargo test
stellar contract build
stellar contract deploy --wasm target/wasm32v1-none/release/bounty_pot.wasm --source alice --network testnet --alias bounty-pot
```

The tests need no network: `cargo test --offline`.

## What is on chain and what is not

- **On chain:** the money. The sponsor cannot take it back before the deadline, the host can pay exactly once, and if nobody is paid the sponsor can refund after the deadline.
- **Off chain:** the questions, answers and scoring. They live in the game server so players can't read the answers ahead of time. The host's key names the winners, so scoring is only as honest as the host.

## The game server

```bash
cd server
npm install
npm start
```

It prints a **host token** and the host key's address. Open the app, choose Host view, and enter the token and a pot id.

| Environment variable | Default |
|---|---|
| `POT_CONTRACT` | the contract ID above |
| `HOST_KEY` | `host` (a Stellar CLI identity that signs `pay`) |
| `STELLAR_NETWORK` | `testnet` |
| `HOST_TOKEN` | random, printed at startup |
| `PORT` | `8787` |

The server checks the pot on chain before opening a game, keeps the answers, scores answers on its own clock (500 points plus up to 500 for speed), and pays the top three **50 / 30 / 20** when the host clicks pay.

The host key is a CLI identity, created once with:

```bash
stellar keys generate host --network testnet --fund
```

No key files are committed. `keys.md` is ignored by git.

## The web app

```bash
cd app
npm install
cp .env.example .env.local   # optional: add a Pollar pub_testnet_ key
npm run dev
```

- Players open the page and join with a name and a testnet address, or sign in with Google through [Pollar](https://docs.pollar.xyz) when a key is set.
- Add `#host` to the address for the host view. "Player view" and "Host view" switch between them.
- Phones join at the LAN address Vite prints. Google login needs a secure context (HTTPS or localhost); without one, players paste an address.

Pollar setup: in the [dashboard](https://dashboard.pollar.xyz), add the app's origin to **Allowed origins** and `/oauth/callback` to **Allowed redirect URIs**, or every login is refused. Only a publishable key belongs in the app; the secret key is never needed.

## Layout

```text
contracts/bounty-pot   the contract and its tests
server                 game server: rooms, questions, scoring, payout
app                    Vite + React: player view, host view
```

## Known limits

- One game runs at a time.
- Ties are ranked by join order.
- The server accepts any Stellar address, so one person can enter with several wallets.
