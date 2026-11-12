#![cfg(test)]
use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::{StellarAssetClient, TokenClient},
    vec, Address, Env,
};

const DEADLINE: u64 = 1_000;

struct Setup<'a> {
    sponsor: Address,
    host: Address,
    token: TokenClient<'a>,
    pot: BountyPotClient<'a>,
}

fn setup(env: &Env) -> Setup<'_> {
    env.mock_all_auths();
    let sponsor = Address::generate(env);
    let host = Address::generate(env);
    let token = env
        .register_stellar_asset_contract_v2(Address::generate(env))
        .address();
    StellarAssetClient::new(env, &token).mint(&sponsor, &100);
    let pot = env.register(BountyPot, ());
    Setup {
        sponsor,
        host,
        token: TokenClient::new(env, &token),
        pot: BountyPotClient::new(env, &pot),
    }
}

fn create(s: &Setup) -> u32 {
    s.pot.create(&s.sponsor, &s.host, &s.token.address, &100, &DEADLINE)
}

fn payout(to: &Address, amount: i128) -> Payout {
    Payout { to: to.clone(), amount }
}

#[test]
fn pays_winners_and_returns_leftover() {
    let env = Env::default();
    let s = setup(&env);
    let (a, b) = (Address::generate(&env), Address::generate(&env));
    let id = create(&s);
    assert_eq!(s.token.balance(&s.pot.address), 100);

    s.pot.pay(&id, &vec![&env, payout(&a, 50), payout(&b, 30)]);

    assert_eq!(s.token.balance(&a), 50);
    assert_eq!(s.token.balance(&b), 30);
    assert_eq!(s.token.balance(&s.sponsor), 20);
    assert_eq!(s.token.balance(&s.pot.address), 0);
    assert!(!s.pot.get(&id).open);
}

#[test]
fn pay_needs_the_host() {
    let env = Env::default();
    let s = setup(&env);
    let id = create(&s);
    s.pot.pay(&id, &vec![&env, payout(&Address::generate(&env), 10)]);
    assert_eq!(env.auths()[0].0, s.host);
}

#[test]
fn cannot_pay_twice() {
    let env = Env::default();
    let s = setup(&env);
    let a = Address::generate(&env);
    let id = create(&s);
    s.pot.pay(&id, &vec![&env, payout(&a, 50)]);
    assert_eq!(
        s.pot.try_pay(&id, &vec![&env, payout(&a, 50)]),
        Err(Ok(Error::Closed))
    );
}

#[test]
fn rejects_bad_payouts() {
    let env = Env::default();
    let s = setup(&env);
    let a = Address::generate(&env);
    let id = create(&s);
    let over = vec![&env, payout(&a, 60), payout(&a, 41)];
    assert_eq!(s.pot.try_pay(&id, &over), Err(Ok(Error::OverBudget)));
    let zero = vec![&env, payout(&a, 0)];
    assert_eq!(s.pot.try_pay(&id, &zero), Err(Ok(Error::InvalidAmount)));
    assert_eq!(s.pot.try_pay(&id, &vec![&env]), Err(Ok(Error::NoWinners)));
    assert_eq!(s.token.balance(&s.pot.address), 100);
    assert!(s.pot.get(&id).open);
}

#[test]
fn refund_only_after_deadline() {
    let env = Env::default();
    let s = setup(&env);
    let id = create(&s);
    assert_eq!(s.pot.try_refund(&id), Err(Ok(Error::TooEarly)));

    env.ledger().set_timestamp(DEADLINE + 1);
    let late = vec![&env, payout(&Address::generate(&env), 10)];
    assert_eq!(s.pot.try_pay(&id, &late), Err(Ok(Error::TooLate)));

    s.pot.refund(&id);
    assert_eq!(s.token.balance(&s.sponsor), 100);
    assert_eq!(s.pot.try_refund(&id), Err(Ok(Error::Closed)));
}

#[test]
fn rejects_bad_create_and_unknown_pot() {
    let env = Env::default();
    let s = setup(&env);
    let t = &s.token.address;
    assert_eq!(
        s.pot.try_create(&s.sponsor, &s.host, t, &0, &DEADLINE),
        Err(Ok(Error::InvalidAmount))
    );
    env.ledger().set_timestamp(DEADLINE);
    assert_eq!(
        s.pot.try_create(&s.sponsor, &s.host, t, &100, &DEADLINE),
        Err(Ok(Error::InvalidDeadline))
    );
    assert_eq!(s.pot.try_get(&7), Err(Ok(Error::NotFound)));
}

#[test]
fn ids_count_up_per_pot() {
    let env = Env::default();
    let s = setup(&env);
    StellarAssetClient::new(&env, &s.token.address).mint(&s.sponsor, &100);
    assert_eq!(create(&s), 0);
    assert_eq!(create(&s), 1);
}
