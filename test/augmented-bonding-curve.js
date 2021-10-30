const MiniMeToken = artifacts.require('@aragon/minime/contracts/MiniMeToken.sol:MiniMeToken')
const TokenManager = artifacts.require('TokenManager')
const Agent = artifacts.require('Agent')
const Formula = artifacts.require('BancorFormula')
const AugmentedBondingCurve = artifacts.require('AugmentedBondingCurve')
const TokenMock = artifacts.require('TokenMock')
const ERC20 = artifacts.require('ERC20')

const { assertEvent, assertBn } = require('@aragon/contract-helpers-test/src/asserts')
const getBalance = require('./helpers/getBalance')(web3, TokenMock)
const random = require('./helpers/random')
const assertExternalEvent = require('./helpers/assertExternalEvent')
const { bn, bigExp } = require('@aragon/contract-helpers-test/src/numbers')
const { ZERO_ADDRESS } = require('@aragon/contract-helpers-test')
const { newDao, installNewApp } = require('@aragon/contract-helpers-test/src/aragon-os')
const { assertRevert } = require('./helpers/assertThrow')

const { hash } = require('eth-ens-namehash')
const forEach = require('mocha-each')

const RESERVE_ID = hash('agent.aragonpm.eth')
const TOKEN_MANAGER_ID = hash('token-manager.aragonpm.eth')
const MARKET_MAKER_ID = hash('augmented-bonding-curve.aragonpm.eth')

const INITIAL_TOKEN_BALANCE = bigExp(10000, 18) // 10000 DAIs or ANTs
const PPM = 1000000
const PCT_BASE = bn('1000000000000000000')

const BUY_FEE_PERCENT = bn('100000000000000000') // 10%
const SELL_FEE_PERCENT = bn('100000000000000000') // 10%

const VIRTUAL_SUPPLIES = [bigExp(1, 23), bigExp(1, 22)]
const VIRTUAL_BALANCES = [bigExp(1, 22), bigExp(1, 20)]
const RESERVE_RATIOS = [(PPM * 10) / 100, (PPM * 1) / 100]

const ETH = ZERO_ADDRESS

const balanceOf = async (who, token) => {
  return bn(
    token === ETH ? await web3.eth.getBalance(who) : await (await ERC20.at(token)).balanceOf(who)
  )
}

contract('AugmentedBondingCurve app', (accounts) => {
  let dao,
    acl,
    tBase,
    rBase,
    mBase,
    token,
    tokenManager,
    reserve,
    formula,
    marketMaker,
    collateral,
    collaterals
  let MINT_ROLE, BURN_ROLE, TRANSFER_ROLE

  let UPDATE_FORMULA_ROLE,
    UPDATE_BENEFICIARY_ROLE,
    UPDATE_FEES_ROLE,
    MANAGE_COLLATERAL_TOKEN_ROLE,
    MAKE_BUY_ORDER_ROLE,
    MAKE_SELL_ORDER_ROLE

  const [root, authorized, authorized2, unauthorized, beneficiary] = accounts

  const initialize = async () => {
    // DAO
    const { dao: _dao, acl: _acl } = await newDao(root)
    dao = _dao
    acl = _acl
    // token
    token = await MiniMeToken.new(ZERO_ADDRESS, ZERO_ADDRESS, 0, 'Bond', 18, 'BON', false)
    // token manager
    tokenManager = await TokenManager.at(
      await installNewApp(dao, TOKEN_MANAGER_ID, tBase.address, root)
    )
    // pool
    reserve = await Agent.at(await installNewApp(dao, RESERVE_ID, rBase.address, root))
    // bancor-curve
    marketMaker = await AugmentedBondingCurve.at(
      await installNewApp(dao, MARKET_MAKER_ID, mBase.address, root)
    )
    // permissions

    const createPermissions = async (grantee, app, roles, manager, options) => {
      for (const role of roles) {
        await acl.createPermission(grantee, app, role, manager, options)
      }
    }
    const grantPermissions = async (grantee, app, roles, options) => {
      for (const role of roles) {
        await acl.grantPermission(grantee, app, role, options)
      }
    }

    const marketMakerRoles = [
      UPDATE_FORMULA_ROLE,
      UPDATE_BENEFICIARY_ROLE,
      UPDATE_FEES_ROLE,
      MANAGE_COLLATERAL_TOKEN_ROLE,
      MAKE_BUY_ORDER_ROLE,
      MAKE_SELL_ORDER_ROLE,
    ]

    await acl.createPermission(marketMaker.address, tokenManager.address, MINT_ROLE, root, {
      from: root,
    })
    await acl.createPermission(marketMaker.address, tokenManager.address, BURN_ROLE, root, {
      from: root,
    })
    await acl.createPermission(marketMaker.address, reserve.address, TRANSFER_ROLE, root, {
      from: root,
    })
    await createPermissions(authorized, marketMaker.address, marketMakerRoles, root, { from: root })
    await grantPermissions(authorized2, marketMaker.address, marketMakerRoles, { from: root })
    // collaterals
    collateral = await MiniMeToken.new(
      ZERO_ADDRESS,
      ZERO_ADDRESS,
      0,
      'Collateral',
      18,
      'COLL',
      true,
      { from: authorized }
    )
    await collateral.generateTokens(authorized, INITIAL_TOKEN_BALANCE, { from: authorized })
    await collateral.generateTokens(authorized2, INITIAL_TOKEN_BALANCE, { from: authorized })
    collaterals = [ETH, collateral.address]
    // allowances
    await collateral.approve(marketMaker.address, INITIAL_TOKEN_BALANCE, { from: authorized })
    await collateral.approve(marketMaker.address, INITIAL_TOKEN_BALANCE, { from: authorized2 })
    // initializations
    await token.changeController(tokenManager.address)
    await tokenManager.initialize(token.address, true, 0)
    await reserve.initialize()
    await marketMaker.initialize(
      tokenManager.address,
      formula.address,
      reserve.address,
      beneficiary,
      BUY_FEE_PERCENT,
      SELL_FEE_PERCENT
    )
    // end up initializing market maker
    await marketMaker.addCollateralToken(
      ETH,
      VIRTUAL_SUPPLIES[0],
      VIRTUAL_BALANCES[0],
      RESERVE_RATIOS[0],
      { from: authorized }
    )
    await marketMaker.addCollateralToken(
      collateral.address,
      VIRTUAL_SUPPLIES[1],
      VIRTUAL_BALANCES[1],
      RESERVE_RATIOS[1],
      {
        from: authorized,
      }
    )
  }

  const purchaseReturn = async (index, supply, balance, amount) => {
    supply = bn(supply)
    balance = bn(balance)
    amount = bn(amount)

    return formula.calculatePurchaseReturn(
      VIRTUAL_SUPPLIES[index].add(supply),
      VIRTUAL_BALANCES[index].add(balance),
      RESERVE_RATIOS[index],
      amount
    )
  }

  const expectedPurchaseReturnForAmount = async (index, amount) => {
    const fee = computeBuyFee(amount)
    const amountNoFee = amount.sub(fee)

    const supply = await token.totalSupply()
    const balanceOfReserve = await balanceOf(reserve.address, collaterals[index])
    return purchaseReturn(index, supply, balanceOfReserve, amountNoFee)
  }

  const saleReturn = async (index, supply, balance, amount) => {
    supply = bn(supply)
    balance = bn(balance)
    amount = bn(amount)

    return formula.calculateSaleReturn(
      VIRTUAL_SUPPLIES[index].add(supply),
      VIRTUAL_BALANCES[index].add(balance),
      RESERVE_RATIOS[index],
      amount
    )
  }

  const expectedSaleReturnForAmount = async (index, amount) => {
    const supply = await token.totalSupply()
    const balanceOfReserve = await balanceOf(reserve.address, collaterals[index])
    const saleReturnAmount = await saleReturn(index, supply, balanceOfReserve, amount)

    const fee = await sellFeeAfterExchange(index, amount)
    return saleReturnAmount.sub(fee)
  }

  const sellFeeAfterExchange = async (index, amount) => {
    const supply = await token.totalSupply()
    const balanceOfReserve = await balanceOf(reserve.address, collaterals[index])
    const saleReturnAmount = await saleReturn(index, supply, balanceOfReserve, amount)

    return computeSellFee(saleReturnAmount)
  }

  const computeBuyFee = (amount) => {
    amount = bn(amount)
    return amount.mul(BUY_FEE_PERCENT).div(PCT_BASE)
  }

  const computeSellFee = (amount) => {
    amount = bn(amount)
    return amount.mul(SELL_FEE_PERCENT).div(PCT_BASE)
  }

  const getCollateralToken = async (collateral) => {
    const {
      0: whitelisted,
      1: virtualSupply,
      2: virtualBalance,
      3: reserveRatio,
    } = await marketMaker.getCollateralToken(collateral)

    return { whitelisted, virtualSupply, virtualBalance, reserveRatio }
  }

  const makeBuyOrder = async (buyer, collateral, paidAmount, minReturnAmount, opts = {}) => {
    const from = opts && opts.from ? opts.from : buyer
    const value =
      collateral === ETH
        ? opts && opts.value
          ? opts.value
          : paidAmount
        : opts && opts.value
        ? opts.value
        : 0
    return marketMaker.makeBuyOrder(buyer, collateral, paidAmount, minReturnAmount, {
      from,
      value,
    })
  }

  const makeSellOrder = async (seller, collateral, paidAmount, minReturnAmount, opts = {}) => {
    const from = opts && opts.from ? opts.from : seller
    return marketMaker.makeSellOrder(seller, collateral, paidAmount, minReturnAmount, {
      from,
    })
  }

  before(async () => {
    // formula
    formula = await Formula.new()
    // base contracts
    tBase = await TokenManager.new()
    rBase = await Agent.new()
    mBase = await AugmentedBondingCurve.new()
    // constants
    TRANSFER_ROLE = await rBase.TRANSFER_ROLE()
    MINT_ROLE = await tBase.MINT_ROLE()
    BURN_ROLE = await tBase.BURN_ROLE()

    UPDATE_FORMULA_ROLE = await mBase.UPDATE_FORMULA_ROLE()
    UPDATE_BENEFICIARY_ROLE = await mBase.UPDATE_BENEFICIARY_ROLE()
    UPDATE_FEES_ROLE = await mBase.UPDATE_FEES_ROLE()
    MANAGE_COLLATERAL_TOKEN_ROLE = await mBase.MANAGE_COLLATERAL_TOKEN_ROLE()
    MAKE_BUY_ORDER_ROLE = await mBase.MAKE_BUY_ORDER_ROLE()
    MAKE_SELL_ORDER_ROLE = await mBase.MAKE_SELL_ORDER_ROLE()
  })

  beforeEach(async () => {
    await initialize()
  })
  context('> #deploy', () => {
    it('> it should deploy', async () => {
      await AugmentedBondingCurve.new()
    })
  })

  context('> #initialize', () => {
    context('> initialization parameters are correct', () => {
      it('it should initialize the augmented bonding curve', async () => {
        assert.equal(await marketMaker.tokenManager(), tokenManager.address)
        assert.equal(await marketMaker.token(), token.address)
        assert.equal(await marketMaker.reserve(), reserve.address)
        assert.equal(await marketMaker.beneficiary(), beneficiary)
        assert.equal(await marketMaker.formula(), formula.address)
        assertBn(await marketMaker.buyFeePct(), BUY_FEE_PERCENT)
        assertBn(await marketMaker.sellFeePct(), SELL_FEE_PERCENT)
      })
    })

    context('> initialization parameters are not correct', () => {
      let uninitialized

      beforeEach(async () => {
        uninitialized = await AugmentedBondingCurve.at(
          await installNewApp(dao, MARKET_MAKER_ID, mBase.address, root)
        )
      })

      it('it should revert [token manager is not a contract]', async () => {
        await assertRevert(
          () =>
            uninitialized.initialize(
              authorized,
              formula.address,
              reserve.address,
              beneficiary,
              BUY_FEE_PERCENT,
              SELL_FEE_PERCENT,
              { from: root }
            ),
          'MM_CONTRACT_IS_EOA'
        )
      })

      it('it should revert [token manager setting is invalid]', async () => {
        const token_ = await MiniMeToken.new(
          ZERO_ADDRESS,
          ZERO_ADDRESS,
          0,
          'Bond',
          18,
          'BON',
          false
        )
        const tokenManager_ = await TokenManager.at(
          await installNewApp(dao, TOKEN_MANAGER_ID, tBase.address, root)
        )

        await token_.changeController(tokenManager_.address)
        await tokenManager_.initialize(token_.address, true, 1)

        await assertRevert(
          () =>
            uninitialized.initialize(
              tokenManager_.address,
              formula.address,
              reserve.address,
              beneficiary,
              BUY_FEE_PERCENT,
              SELL_FEE_PERCENT,
              { from: root }
            ),
          'MM_INVALID_TM_SETTING'
        )
      })

      it('it should revert [reserve is not a contract]', async () => {
        await assertRevert(
          () =>
            uninitialized.initialize(
              tokenManager.address,
              formula.address,
              authorized,
              beneficiary,
              BUY_FEE_PERCENT,
              SELL_FEE_PERCENT,
              {
                from: root,
              }
            ),
          'MM_CONTRACT_IS_EOA'
        )
      })

      it('it should revert [formula is not a contract]', async () => {
        await assertRevert(
          () =>
            uninitialized.initialize(
              tokenManager.address,
              authorized,
              reserve.address,
              beneficiary,
              BUY_FEE_PERCENT,
              SELL_FEE_PERCENT,
              {
                from: root,
              }
            ),
          'MM_CONTRACT_IS_EOA'
        )
      })

      it('it should revert [beneficiary is null address]', async () => {
        await assertRevert(
          () =>
            uninitialized.initialize(
              tokenManager.address,
              formula.address,
              reserve.address,
              ZERO_ADDRESS,
              BUY_FEE_PERCENT,
              SELL_FEE_PERCENT,
              {
                from: root,
              }
            ),
          'MM_INVALID_BENEFICIARY'
        )
      })

      it('it should revert [buy fee is not a percentage]', async () => {
        await assertRevert(
          () =>
            uninitialized.initialize(
              tokenManager.address,
              formula.address,
              reserve.address,
              beneficiary,
              PCT_BASE,
              SELL_FEE_PERCENT,
              {
                from: root,
              }
            ),
          'MM_INVALID_PERCENTAGE'
        )
      })

      it('it should revert [sell fee is not a percentage]', async () => {
        await assertRevert(
          () =>
            uninitialized.initialize(
              tokenManager.address,
              formula.address,
              reserve.address,
              beneficiary,
              BUY_FEE_PERCENT,
              PCT_BASE,
              {
                from: root,
              }
            ),
          'MM_INVALID_PERCENTAGE'
        )
      })
    })

    it('it should revert on re-initialization', async () => {
      await assertRevert(
        () =>
          marketMaker.initialize(
            tokenManager.address,
            formula.address,
            reserve.address,
            beneficiary,
            BUY_FEE_PERCENT,
            SELL_FEE_PERCENT,
            { from: root }
          ),
        'INIT_ALREADY_INITIALIZED'
      )
    })
  })

  context('> #addCollateralToken', () => {
    context('> sender has MANAGE_COLLATERAL_TOKEN_ROLE', () => {
      context('> and collateral token has not yet been added', () => {
        context('> and collateral token is ETH or ERC20 [i.e. contract]', () => {
          context('> and reserve ratio is valid', () => {
            it('it should add collateral token', async () => {
              const unlisted = await TokenMock.new(authorized, INITIAL_TOKEN_BALANCE)

              const virtualSupply = random.virtualSupply()
              const virtualBalance = random.virtualBalance()
              const reserveRatio = random.reserveRatio()

              const receipt = await marketMaker.addCollateralToken(
                unlisted.address,
                virtualSupply,
                virtualBalance,
                reserveRatio,
                {
                  from: authorized,
                }
              )
              const collateral = await getCollateralToken(unlisted.address)

              assertEvent(receipt, 'AddCollateralToken')
              assert.equal(collateral.whitelisted, true)
              assertBn(collateral.virtualSupply, virtualSupply)
              assertBn(collateral.virtualBalance, virtualBalance)
              assert.equal(collateral.reserveRatio.toNumber(), reserveRatio)
            })
          })

          context('> but reserve ratio is not valid', () => {
            it('it should revert', async () => {
              const unlisted = await TokenMock.new(authorized, INITIAL_TOKEN_BALANCE)

              await assertRevert(
                () =>
                  marketMaker.addCollateralToken(
                    unlisted.address,
                    random.virtualSupply(),
                    random.virtualBalance(),
                    PPM + 1,
                    {
                      from: authorized,
                    }
                  ),
                'MM_INVALID_RESERVE_RATIO'
              )
            })
          })
        })

        context('> but collateral token is not ETH or ERC20 [i.e. contract]', () => {
          it('it should revert', async () => {
            await assertRevert(() =>
              marketMaker.addCollateralToken(
                authorized,
                random.virtualSupply(),
                random.virtualBalance(),
                random.reserveRatio(),
                {
                  from: authorized,
                }
              )
            )
          })
        })
      })

      context('> but collateral token has already been added', () => {
        it('it should revert', async () => {
          await assertRevert(
            () =>
              marketMaker.addCollateralToken(
                ETH,
                random.virtualSupply(),
                random.virtualBalance(),
                random.reserveRatio(),
                { from: authorized }
              ),
            'MM_COLLATERAL_ALREADY_WHITELISTED'
          )
        })
      })
    })

    context('> sender does not have MANAGE_COLLATERAL_TOKEN_ROLE', () => {
      it('it should revert', async () => {
        const unlisted = await TokenMock.new(authorized, INITIAL_TOKEN_BALANCE)

        await assertRevert(
          () =>
            marketMaker.addCollateralToken(
              unlisted.address,
              random.virtualSupply(),
              random.virtualBalance(),
              random.reserveRatio(),
              {
                from: unauthorized,
              }
            ),
          'APP_AUTH_FAILED'
        )
      })
    })
  })

  context('> #removeCollateralToken', () => {
    context('> sender has MANAGE_COLLATERAL_TOKEN_ROLE', () => {
      context('> and collateral token is whitelisted', () => {
        it('it should remove collateral token', async () => {
          const receipt = await marketMaker.removeCollateralToken(collateral.address, {
            from: authorized,
          })
          const collateral_ = await getCollateralToken(collateral.address)

          assertEvent(receipt, 'RemoveCollateralToken')
          assert.equal(collateral_.whitelisted, false)
          assertBn(collateral_.virtualSupply, 0)
          assertBn(collateral_.virtualBalance, 0)
          assert.equal(collateral_.reserveRatio.toNumber(), 0)
        })
      })

      context('> but collateral token is not whitelisted', () => {
        it('it should revert', async () => {
          const unlisted = await TokenMock.new(authorized, INITIAL_TOKEN_BALANCE)

          await assertRevert(
            () => marketMaker.removeCollateralToken(unlisted.address, { from: authorized }),
            'MM_COLLATERAL_NOT_WHITELISTED'
          )
        })
      })
    })

    context('> sender does not have MANAGE_COLLATERAL_TOKEN_ROLE', () => {
      it('it should revert', async () => {
        await assertRevert(
          () => marketMaker.removeCollateralToken(collateral.address, { from: unauthorized }),
          'APP_AUTH_FAILED'
        )
      })
    })
  })

  context('> #updateCollateralToken', () => {
    context('> sender has MANAGE_COLLATERAL_TOKEN_ROLE', () => {
      context('> and collateral token is whitelisted', () => {
        context('> and reserve ratio is valid', () => {
          it('it should update collateral token', async () => {
            const virtualSupply = random.virtualSupply()
            const virtualBalance = random.virtualBalance()
            const reserveRatio = random.reserveRatio()

            const receipt = await marketMaker.updateCollateralToken(
              collateral.address,
              virtualSupply,
              virtualBalance,
              reserveRatio,
              {
                from: authorized,
              }
            )
            const collateral_ = await getCollateralToken(collateral.address)

            assertEvent(receipt, 'UpdateCollateralToken')
            assert.equal(collateral_.whitelisted, true)
            assertBn(collateral_.virtualSupply, virtualSupply)
            assertBn(collateral_.virtualBalance, virtualBalance)
            assert.equal(collateral_.reserveRatio.toNumber(), reserveRatio)
          })
        })

        context('> but reserve ratio is not valid', () => {
          it('it should revert', async () => {
            await assertRevert(
              () =>
                marketMaker.updateCollateralToken(
                  collateral.address,
                  random.virtualSupply(),
                  random.virtualBalance(),
                  PPM + 1,
                  {
                    from: authorized,
                  }
                ),
              'MM_INVALID_RESERVE_RATIO'
            )
          })
        })
      })

      context('> but collateral token is not whitelisted', () => {
        it('it should revert', async () => {
          const unlisted = await TokenMock.new(authorized, INITIAL_TOKEN_BALANCE)

          await assertRevert(
            () =>
              marketMaker.updateCollateralToken(
                unlisted.address,
                random.virtualSupply(),
                random.virtualBalance(),
                random.reserveRatio(),
                {
                  from: authorized,
                }
              ),
            'MM_COLLATERAL_NOT_WHITELISTED'
          )
        })
      })
    })

    context('> sender does not have MANAGE_COLLATERAL_TOKEN_ROLE', () => {
      it('it should revert', async () => {
        await assertRevert(
          () =>
            marketMaker.updateCollateralToken(
              collateral.address,
              random.virtualSupply(),
              random.virtualBalance(),
              random.reserveRatio(),
              {
                from: unauthorized,
              }
            ),
          'APP_AUTH_FAILED'
        )
      })
    })
  })

  context('> #updateBeneficiary', () => {
    context('> sender has UPDATE_BENEFICIARY_ROLE', () => {
      context('> and beneficiary is valid', () => {
        it('it should update beneficiary', async () => {
          const receipt = await marketMaker.updateBeneficiary(root, { from: authorized })

          assertEvent(receipt, 'UpdateBeneficiary')
          assert.equal(await marketMaker.beneficiary(), root)
        })
      })

      context('> but beneficiary is not valid', () => {
        it('it should revert', async () => {
          await assertRevert(() =>
            marketMaker.updateBeneficiary(ZERO_ADDRESS, { from: authorized })
          )
        })
      })
    })

    context('> sender does not have UPDATE_BENEFICIARY_ROLE', () => {
      it('it should revert', async () => {
        await assertRevert(
          () => marketMaker.updateBeneficiary(root, { from: unauthorized }),
          'APP_AUTH_FAILED'
        )
      })
    })
  })

  context('> #updateFormula', () => {
    context('> sender has UPDATE_FORMULA_ROLE', () => {
      context('> and formula is a contract', () => {
        it('it should update formula', async () => {
          const formula_ = await Formula.new()
          const receipt = await marketMaker.updateFormula(formula_.address, { from: authorized })

          assertEvent(receipt, 'UpdateFormula')
          assert.equal(await marketMaker.formula(), formula_.address)
        })
      })

      context('> but formula is not a contract', () => {
        it('it should revert', async () => {
          await assertRevert(
            () => marketMaker.updateFormula(root, { from: authorized }),
            'MM_CONTRACT_IS_EOA'
          )
        })
      })
    })

    context('> sender does not have UPDATE_FORMULA_ROLE', () => {
      it('it should revert', async () => {
        const formula_ = await Formula.new()

        await assertRevert(
          () => marketMaker.updateFormula(formula_.address, { from: unauthorized }),
          'APP_AUTH_FAILED'
        )
      })
    })
  })

  context('> #updateFees', () => {
    context('> sender has UPDATE_FEES_ROLE', () => {
      context('> and new fees are valid', () => {
        it('it should update fees', async () => {
          const receipt = await marketMaker.updateFees(40, 50, { from: authorized })

          assertEvent(receipt, 'UpdateFees')
          assert.equal((await marketMaker.buyFeePct()).toNumber(), 40)
          assert.equal((await marketMaker.sellFeePct()).toNumber(), 50)
        })
      })

      context('> but new fees are not valid', () => {
        it('it should revert [buy fee is not valid]', async () => {
          await assertRevert(
            () => marketMaker.updateFees(PCT_BASE.add(bn(1)), 50, { from: authorized }),
            'MM_INVALID_PERCENTAGE'
          )
        })

        it('it should revert [sell fee is not valid]', async () => {
          await assertRevert(
            () => marketMaker.updateFees(40, PCT_BASE.add(bn(1)), { from: authorized }),
            'MM_INVALID_PERCENTAGE'
          )
        })
      })
    })

    context('> sender does not have UPDATE_FEES_ROLE', () => {
      it('it should revert', async () => {
        await assertRevert(
          () => marketMaker.updateFees(40, 50, { from: unauthorized }),
          'APP_AUTH_FAILED'
        )
      })
    })
  })

  context('> #makeBuyOrder', () => {
    forEach(['ETH', 'ERC20']).describe(`> %s`, (round) => {
      const index = round === 'ETH' ? 0 : 1

      context('> sender has MAKE_BUY_ORDER_ROLE', () => {
        context('> and collateral is whitelisted', () => {
          context('> and value is not zero', () => {
            context('> and sender has sufficient funds', () => {
              context('> and no excess value is sent', () => {
                it('it should make buy order', async () => {
                  const amount = random.amount()
                  const expectedReturnAmount = await expectedPurchaseReturnForAmount(index, amount)
                  const senderBalanceBefore = await token.balanceOf(authorized)

                  const receipt = await makeBuyOrder(
                    authorized,
                    collaterals[index],
                    amount,
                    expectedReturnAmount,
                    { from: authorized }
                  )

                  const senderBalanceAfter = await token.balanceOf(authorized)
                  assertEvent(receipt, 'MakeBuyOrder')
                  assert.equal(
                    senderBalanceAfter.sub(senderBalanceBefore).toString(),
                    expectedReturnAmount.toString()
                  )
                })

                it('it should deduct fee', async () => {
                  const beneficiaryBalanceBefore = bn(
                    await getBalance(collaterals[index], beneficiary)
                  )
                  const amount = random.amount()
                  const fee = computeBuyFee(amount)

                  await makeBuyOrder(authorized, collaterals[index], amount, 0, {
                    from: authorized,
                  })

                  const beneficiaryBalanceAfter = bn(
                    await getBalance(collaterals[index], beneficiary)
                  )
                  assertBn(beneficiaryBalanceAfter.sub(beneficiaryBalanceBefore), fee)
                })

                it('it should collect collateral', async () => {
                  const reserveBalanceBefore = bn(
                    await getBalance(collaterals[index], reserve.address)
                  )
                  const amount = random.amount()
                  const fee = computeBuyFee(amount)
                  const amountAfterFee = amount.sub(fee)

                  await makeBuyOrder(authorized, collaterals[index], amount, 0, {
                    from: authorized,
                  })

                  const reserveBalanceAfter = bn(
                    await getBalance(collaterals[index], reserve.address)
                  )
                  assertBn(reserveBalanceAfter.sub(reserveBalanceBefore), amountAfterFee)
                })

                context('> but order returns less than min return amount', () => {
                  it('it should revert', async () => {
                    const amount = random.amount()
                    const expectedReturnAmount = bn(
                      await expectedPurchaseReturnForAmount(index, amount)
                    )

                    await assertRevert(
                      () =>
                        makeBuyOrder(
                          authorized,
                          collaterals[index],
                          amount,
                          expectedReturnAmount.add(bn(1)),
                          { from: authorized }
                        ),
                      'MM_SLIPPAGE_EXCEEDS_LIMIT'
                    )
                  })
                })
              })

              context('> but excess value is sent', () => {
                it('it should revert', async () => {
                  const amount = random.amount()

                  await assertRevert(
                    () =>
                      makeBuyOrder(authorized, collaterals[index], amount, 0, {
                        from: authorized,
                        value: amount.add(bn(1)),
                      }),
                    'MM_INVALID_COLLATERAL_VALUE'
                  ) // should revert both for ETH and ERC20
                })
              })
            })

            context('> but sender does not have sufficient funds', () => {
              it('it should revert', async () => {
                const amount = random.amount()
                // let's burn the extra tokens to end up with a small balance
                await collateral.transfer(unauthorized, INITIAL_TOKEN_BALANCE.sub(amount), {
                  from: authorized,
                })

                await assertRevert(
                  () =>
                    makeBuyOrder(authorized, collaterals[index], amount.add(bn(1)), 0, {
                      from: authorized,
                      value: amount.sub(bn(1)),
                    }),
                  'MM_INVALID_COLLATERAL_VALUE'
                ) // should revert both for ETH and ERC20
              })
            })
          })

          context('> but value is zero', () => {
            it('it should revert', async () => {
              await assertRevert(
                () => makeBuyOrder(authorized, collaterals[index], 0, 0, { from: authorized }),
                'MM_INVALID_COLLATERAL_VALUE'
              )
            })
          })
        })

        context('> but collateral is not whitelisted', () => {
          it('it should revert', async () => {
            // we can't test un-whitelisted ETH unless we re-deploy a DAO without ETH as a whitelisted
            // collateral just for that use case it's not worth it because the logic is the same than ERC20 anyhow
            const unlisted = await TokenMock.new(authorized, INITIAL_TOKEN_BALANCE)
            await unlisted.approve(marketMaker.address, INITIAL_TOKEN_BALANCE, {
              from: authorized,
            })
            await assertRevert(
              () =>
                makeBuyOrder(authorized, unlisted.address, random.amount(), 0, {
                  from: authorized,
                }),
              'MM_COLLATERAL_NOT_WHITELISTED'
            )
          })
        })
      })

      context('> sender does not have MAKE_BUY_ORDER_ROLE', () => {
        it('it should revert', async () => {
          await assertRevert(
            () =>
              makeBuyOrder(unauthorized, collaterals[index], random.amount(), 0, {
                from: unauthorized,
              }),
            'APP_AUTH_FAILED'
          )
        })
      })
    })
  })

  context('> #makeSellOrder', () => {
    forEach(['ETH', 'ERC20']).describe(`> %s`, (round) => {
      const index = round === 'ETH' ? 0 : 1

      context('> sender has MAKE_SELL_ORDER_ROLE', () => {
        context('> and collateral is whitelisted', () => {
          context('> and amount is not zero', () => {
            context('> and sender has sufficient funds', () => {
              context('> and pool has sufficient funds', () => {
                context('> and there is one order', () => {
                  it('it should make sell order', async () => {
                    await makeBuyOrder(authorized, collaterals[index], random.amount(), 0, {
                      from: authorized,
                    })

                    const collateralBalanceBefore = await balanceOf(authorized, collaterals[index])
                    const tokenBalanceBefore = await token.balanceOf(authorized)
                    const expectedSaleReturn = await expectedSaleReturnForAmount(
                      index,
                      tokenBalanceBefore
                    )

                    const sellReceipt = await makeSellOrder(
                      authorized,
                      collaterals[index],
                      tokenBalanceBefore,
                      expectedSaleReturn,
                      { from: authorized2 }
                    )

                    const tokenBalanceAfter = await token.balanceOf(authorized)
                    const collateralBalanceAfter = await balanceOf(authorized, collaterals[index])
                    const reserveBalanceAfter = await reserve.balance(collaterals[index])
                    const collateralReturned = collateralBalanceAfter.sub(collateralBalanceBefore)

                    assertEvent(sellReceipt, 'MakeSellOrder')
                    assertBn(tokenBalanceAfter, 0)
                    assert.closeTo(reserveBalanceAfter.toNumber(), 0, 1)
                    assertBn(await token.totalSupply(), 0)
                    assertBn(collateralReturned, expectedSaleReturn)
                  })

                  it('it should collect fees', async () => {
                    await makeBuyOrder(authorized, collaterals[index], random.amount(), 0, {
                      from: authorized,
                    })
                    const senderBalance = await token.balanceOf(authorized)
                    const beneficiaryBalanceBefore = await balanceOf(
                      beneficiary,
                      collaterals[index]
                    )
                    const fee = await sellFeeAfterExchange(index, senderBalance)

                    await makeSellOrder(authorized, collaterals[index], senderBalance, 0, {
                      from: authorized,
                    })

                    const beneficiaryBalanceAfter = await balanceOf(beneficiary, collaterals[index])
                    assertBn(beneficiaryBalanceAfter.sub(beneficiaryBalanceBefore), fee)
                  })
                })
              })

              context('> but pool does not have sufficient funds', () => {
                it('it should revert', async () => {
                  const index_ = index === 1 ? 0 : 1
                  // let's add some collateral into the pool

                  await makeBuyOrder(authorized, collaterals[index], random.amount(), 0, {
                    from: authorized,
                  })
                  await makeBuyOrder(authorized, collaterals[index_], random.amount(), 0, {
                    from: authorized,
                  })
                  const senderBalance = await token.balanceOf(authorized)

                  // redeem more bonds against the base collateral than it can pay for and assert it reverts
                  await assertRevert(
                    () =>
                      makeSellOrder(authorized, collaterals[index], senderBalance, 0, {
                        from: authorized,
                      }),
                    index === 0 ? 'VAULT_SEND_REVERTED' : 'VAULT_TOKEN_TRANSFER_REVERTED'
                  )
                })
              })

              context('> but order returns less than minReturnAmount', () => {
                it('it should revert', async () => {
                  await makeBuyOrder(authorized, collaterals[index], random.amount(), 0, {
                    from: authorized,
                  })
                  const senderBalance = await token.balanceOf(authorized)

                  const expectedSaleReturn = await expectedSaleReturnForAmount(index, senderBalance)

                  await assertRevert(
                    () =>
                      makeSellOrder(
                        authorized,
                        collaterals[index],
                        senderBalance,
                        expectedSaleReturn.add(bn(1)),
                        { from: authorized }
                      ),
                    'MM_SLIPPAGE_EXCEEDS_LIMIT'
                  )
                })
              })
            })

            context('> but sender does not have sufficient funds', () => {
              it('it should revert', async () => {
                await makeBuyOrder(authorized, collaterals[index], random.amount(), 0, {
                  from: authorized,
                })
                const senderBalance = await token.balanceOf(authorized)

                await assertRevert(
                  () =>
                    makeSellOrder(authorized, collaterals[index], senderBalance.add(bn(1)), 0, {
                      from: authorized,
                    }),
                  'MM_INVALID_BOND_AMOUNT'
                )
              })
            })
          })

          context('> but amount is zero', () => {
            it('it should revert', async () => {
              await makeBuyOrder(authorized, collaterals[index], random.amount(), 0, {
                from: authorized,
              })

              await assertRevert(
                () => makeSellOrder(authorized, collaterals[index], 0, 0, { from: authorized }),
                'MM_INVALID_BOND_AMOUNT'
              )
            })
          })
        })

        context('> but collateral is not whitelisted', () => {
          it('it should revert', async () => {
            // we can't test un-whitelisted ETH unless we re-deploy a DAO without ETH as a whitelisted
            // collateral just for that use case it's not worth it because the logic is the same than ERC20 anyhow
            const unlisted = await TokenMock.new(authorized, INITIAL_TOKEN_BALANCE)
            await unlisted.approve(marketMaker.address, INITIAL_TOKEN_BALANCE, {
              from: authorized,
            })
            await makeBuyOrder(authorized, collaterals[index], random.amount(), 0, {
              from: authorized,
            })
            const senderBalance = await token.balanceOf(authorized)

            await assertRevert(
              () =>
                makeSellOrder(authorized, unlisted.address, senderBalance, 0, {
                  from: authorized,
                }),
              'MM_COLLATERAL_NOT_WHITELISTED'
            )
          })
        })
      })

      context('> sender does not have MAKE_SELL_ORDER_ROLE', () => {
        it('it should revert', async () => {
          await makeBuyOrder(authorized, collaterals[index], random.amount(), 0, {
            from: authorized,
          })
          const senderBalance = await token.balanceOf(authorized)

          await assertRevert(
            () =>
              makeSellOrder(authorized, collaterals[index], senderBalance, 0, {
                from: unauthorized,
              }),
            'APP_AUTH_FAILED'
          )
        })
      })
    })
  })

  context('> #receiveApproval', () => {
    let amount

    beforeEach(async () => {
      amount = random.amount()
      await collateral.approve(marketMaker.address, 0, { from: authorized })
    })

    it('successfully calls approveAndCall()', async () => {
      const makeBuyOrderData = marketMaker.contract.methods
        .makeBuyOrder(authorized, collaterals[1], amount, 0)
        .encodeABI()

      const receipt = await collateral.approveAndCall(
        marketMaker.address,
        amount,
        makeBuyOrderData,
        { from: authorized }
      )

      assertExternalEvent(receipt, 'MakeBuyOrder(address,address,uint256,uint256,uint256,uint256)')
    })

    it('reverts when does not have MAKE_BUY_ORDER_ROLE', async () => {
      const makeBuyOrderData = marketMaker.contract.methods
        .makeBuyOrder(authorized, collaterals[1], amount, 0)
        .encodeABI()
      await acl.revokePermission(authorized, marketMaker.address, MAKE_BUY_ORDER_ROLE, {
        from: root,
      })
      await assertRevert(
        collateral.approveAndCall(marketMaker.address, amount, makeBuyOrderData, {
          from: authorized,
        }),
        'MM_NO_PERMISSION'
      )
    })

    it('reverts when data is for function other than makeBuyOrder', async () => {
      const makeBuyOrderData = marketMaker.contract.methods
        .makeSellOrder(authorized, collaterals[1], amount, 0)
        .encodeABI()

      await assertRevert(
        collateral.approveAndCall(marketMaker.address, amount, makeBuyOrderData, {
          from: authorized,
        }),
        'MM_NOT_BUY_FUNCTION'
      )
    })

    it('reverts when buyer in data is not equal to from address', async () => {
      const makeBuyOrderData = marketMaker.contract.methods
        .makeBuyOrder(authorized2, collaterals[1], amount, 0)
        .encodeABI()

      await assertRevert(
        collateral.approveAndCall(marketMaker.address, amount, makeBuyOrderData, {
          from: authorized,
        }),
        'MM_BUYER_NOT_FROM'
      )
    })

    it('reverts when collateral in data is not equal to token address', async () => {
      const makeBuyOrderData = marketMaker.contract.methods
        .makeBuyOrder(authorized, authorized, amount, 0)
        .encodeABI()

      await assertRevert(
        collateral.approveAndCall(marketMaker.address, amount, makeBuyOrderData, {
          from: authorized,
        }),
        'MM_COLLATERAL_NOT_SENDER'
      )
    })

    it('reverts when deposit amount in data is not equal to token amount', async () => {
      const makeBuyOrderData = marketMaker.contract.methods
        .makeBuyOrder(authorized, collaterals[1], amount.add(bn(1)), 0)
        .encodeABI()

      await assertRevert(
        collateral.approveAndCall(marketMaker.address, amount, makeBuyOrderData, {
          from: authorized,
        }),
        'MM_DEPOSIT_NOT_AMOUNT'
      )
    })
  })
})
