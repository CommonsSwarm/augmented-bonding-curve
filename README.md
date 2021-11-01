Augmented Bonding Curve
=======================

**Disclaimer:** This is an open source app. None of the people or institutions involved in its development may be held accountable for how it is used. If you do use it please make sure you comply to the jurisdictions you may be jubjected to.

## How does it work

This module provides market liquidity to the fundraising campaign by automatically matching all the buy and sell orders according to a bonding curve tied to the Bancor formula.

## Initialization

Augmented Bonding Curve is initialized with:
* `_tokenManager` The address of the token manager contract
* `_formula`      The address of the BancorFormula computation contract
* `_reserve`      The address of the **reserve pool** contract
* `_beneficiary`  The address of the **common pool** contract (to whom fees are to be sent)
* `_buyFeePct`    The **entry tribute** to be deducted from buy orders (in PCT_BASE)
* `_sellFeePct`   The **exit tribute** to be deducted from sell orders (in PCT_BASE)

## Roles

The augmented bonding curve app implements the following roles:
* **MAKE_BUY_ORDER_ROLE**: Necessary to convert collateral tokens into bonded tokens.
* **MAKE_SELL_ORDER_ROLE**: Necessary to convert bonded tokens into collateral tokens.
* **MANAGE_COLLATERAL_TOKEN_ROLE**: Used to manage more than one collateral (many bonding curves can be managed with just one instance of the app).
* **UPDATE_FORMULA_ROLE**: Used in case we need to update the bonding curve formula.
* **UPDATE_BENEFICIARY_ROLE**: Used in case we need to update the funding pool address.
* **UPDATE_FEES_ROLE**: Used to change entry and exit fees/tributes.

The augmented bonding curve app should have the following roles:
* **MINT_ROLE** and **BURN_ROLE**: It should be able to create and destroy tokens from Token Manager.
* **TRANSFER_ROLE**: It should be able to transfer funds from the reserve pool.

## Interface

Tokens can be converted using the [convert](https://github.com/CommonsSwarm/tec-convert) frontend.

## Contributing

We welcome community contributions!

Please check out our [open Issues](https://github.com/commonsswarm/augmented-bonding-curve/issues) to get started.

If you discover something that could potentially impact security, please notify us immediately. The quickest way to reach us is via the #dev channel in our [Discord chat](https://discord.gg/n58U4hA). Just say hi and that you discovered a potential security vulnerability and we'll DM you to discuss details.
