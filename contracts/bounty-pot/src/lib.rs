#![no_std]
//! Bounty pots for games. A sponsor locks a prize for one game, the game's
//! host names the winners, and the contract pays them in one transaction.
//! Answers and scoring stay off chain; this contract only holds and pays money.
use soroban_sdk::{contract, contracterror, contractimpl, contracttype, token, Address, Env, Vec};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    InvalidAmount = 1,
    InvalidDeadline = 2,
    NotFound = 3,
    Closed = 4,
    OverBudget = 5,
    NoWinners = 6,
    TooEarly = 7,
    TooLate = 8,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Pot {
    pub sponsor: Address,
    pub host: Address,
    pub token: Address,
    pub amount: i128,
    /// Unix seconds. The host can pay up to this time; the sponsor can refund after it.
    pub deadline: u64,
    pub open: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Payout {
    pub to: Address,
    pub amount: i128,
}

#[contracttype]
enum Key {
    NextId,
    Pot(u32),
}

// About 5 seconds per ledger.
const DAY: u32 = 17_280;
const TTL_THRESHOLD: u32 = 7 * DAY;
const TTL_EXTEND_TO: u32 = 30 * DAY;

fn load(env: &Env, id: u32) -> Result<Pot, Error> {
    env.storage()
        .persistent()
        .get(&Key::Pot(id))
        .ok_or(Error::NotFound)
}

fn save(env: &Env, id: u32, pot: &Pot) {
    let key = Key::Pot(id);
    let store = env.storage().persistent();
    store.set(&key, pot);
    store.extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);
}

#[contract]
pub struct BountyPot;

#[contractimpl]
impl BountyPot {
    /// The sponsor locks `amount` of `token` for one game and gets back its pot id.
    pub fn create(
        env: Env,
        sponsor: Address,
        host: Address,
        token: Address,
        amount: i128,
        deadline: u64,
    ) -> Result<u32, Error> {
        sponsor.require_auth();
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        if deadline <= env.ledger().timestamp() {
            return Err(Error::InvalidDeadline);
        }

        let instance = env.storage().instance();
        let id: u32 = instance.get(&Key::NextId).unwrap_or(0);
        instance.set(&Key::NextId, &(id + 1));
        instance.extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);

        let pot = Pot {
            sponsor: sponsor.clone(),
            host,
            token: token.clone(),
            amount,
            deadline,
            open: true,
        };
        save(&env, id, &pot);

        token::TokenClient::new(&env, &token).transfer(
            &sponsor,
            &env.current_contract_address(),
            &amount,
        );
        Ok(id)
    }

    /// The host pays the winners once. Any amount left over goes back to the sponsor.
    pub fn pay(env: Env, id: u32, winners: Vec<Payout>) -> Result<(), Error> {
        let mut pot = load(&env, id)?;
        pot.host.require_auth();
        if !pot.open {
            return Err(Error::Closed);
        }
        if env.ledger().timestamp() > pot.deadline {
            return Err(Error::TooLate);
        }
        if winners.is_empty() {
            return Err(Error::NoWinners);
        }

        let mut total: i128 = 0;
        for w in winners.iter() {
            if w.amount <= 0 {
                return Err(Error::InvalidAmount);
            }
            total = total.checked_add(w.amount).ok_or(Error::OverBudget)?;
        }
        if total > pot.amount {
            return Err(Error::OverBudget);
        }
        let leftover = pot.amount - total;

        // Close the pot before moving money.
        pot.open = false;
        pot.amount = 0;
        save(&env, id, &pot);

        let client = token::TokenClient::new(&env, &pot.token);
        let me = env.current_contract_address();
        for w in winners.iter() {
            client.transfer(&me, &w.to, &w.amount);
        }
        if leftover > 0 {
            client.transfer(&me, &pot.sponsor, &leftover);
        }
        Ok(())
    }

    /// After the deadline, the sponsor can take back a pot that was never paid.
    pub fn refund(env: Env, id: u32) -> Result<(), Error> {
        let mut pot = load(&env, id)?;
        pot.sponsor.require_auth();
        if !pot.open {
            return Err(Error::Closed);
        }
        if env.ledger().timestamp() <= pot.deadline {
            return Err(Error::TooEarly);
        }

        let amount = pot.amount;
        pot.open = false;
        pot.amount = 0;
        save(&env, id, &pot);

        token::TokenClient::new(&env, &pot.token).transfer(
            &env.current_contract_address(),
            &pot.sponsor,
            &amount,
        );
        Ok(())
    }

    pub fn get(env: Env, id: u32) -> Result<Pot, Error> {
        load(&env, id)
    }
}

mod test;
