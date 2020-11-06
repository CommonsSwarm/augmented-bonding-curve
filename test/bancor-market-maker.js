const MiniMeToken = artifacts.require('MiniMeToken')
const Controller = artifacts.require('MarketplaceControllerMock')
const TokenManager = artifacts.require('TokenManager')
const Agent = artifacts.require('Agent')
const Formula = artifacts.require('BancorFormula')
const BancorMarketMaker = artifacts.require('BancorMarketMaker')
const TokenMock = artifacts.require('TokenMock')

const { assertEvent, assertRevert, assertBn } = require('@aragon/contract-helpers-test/src/asserts')
const getBalance = require('@1hive/apps-marketplace-shared-test-helpers/getBalance')(web3, TokenMock)
const random = require('@1hive/apps-marketplace-shared-test-helpers/random')
const { bn, bigExp } = require('@aragon/contract-helpers-test/src/numbers')
const { injectWeb3, injectArtifacts, ZERO_ADDRESS } = require('@aragon/contract-helpers-test')
const { newDao, installNewApp } = require('@aragon/contract-helpers-test/src/aragon-os')

injectWeb3(web3)
injectArtifacts(artifacts)

const { hash } = require('eth-ens-namehash')
const forEach = require('mocha-each')

const RESERVE_ID = hash('agent.aragonpm.eth')
const TOKEN_MANAGER_ID = hash('token-manager.aragonpm.eth')
const CONTROLLER_ID = hash('marketplace-controller.aragonpm.eth')
const MARKET_MAKER_ID = hash('bancor-market-maker.aragonpm.eth')

const INITIAL_TOKEN_BALANCE = bigExp(10000, 18) // 10000 DAIs or ANTs
const PPM = 1000000
const PCT_BASE = bn('1000000000000000000')

const BUY_FEE_PERCENT = bn('100000000000000000') // 1%
const SELL_FEE_PERCENT = bn('100000000000000000')

const VIRTUAL_SUPPLIES = [bigExp(1, 23), bigExp(1, 22)]
const VIRTUAL_BALANCES = [bigExp(1, 22), bigExp(1, 20)]
const RESERVE_RATIOS = [(PPM * 10) / 100, (PPM * 1) / 100]

const { ETH } = require('@1hive/apps-marketplace-shared-test-helpers/constants')

contract('BancorMarketMaker app', accounts => {
  let dao, acl, cBase, tBase, rBase, mBase, token, tokenManager, controller, reserve, formula, marketMaker,
    collateral, collaterals
  let MINT_ROLE,
    BURN_ROLE,
    CONTROLLER_ROLE,
    TRANSFER_ROLE

  const root = accounts[0]
  const authorized = accounts[1]
  const authorized2 = accounts[2]
  const unauthorized = accounts[3]
  const beneficiary = accounts[4]

  const initialize = async open => {
    // DAO
    const { dao: _dao, acl: _acl } = await newDao(root)
    dao = _dao
    acl = _acl
    // token
    token = await MiniMeToken.new(ZERO_ADDRESS, ZERO_ADDRESS, 0, 'Bond', 18, 'BON', false)
    // market maker controller
    controller = await Controller.at(await installNewApp(dao, CONTROLLER_ID, cBase.address, root))
    // token manager
    tokenManager = await TokenManager.at(await installNewApp(dao, TOKEN_MANAGER_ID, tBase.address, root))
    // pool
    reserve = await Agent.at(await installNewApp(dao, RESERVE_ID, rBase.address, root))
    // bancor-curve
    marketMaker = await BancorMarketMaker.at(await installNewApp(dao, MARKET_MAKER_ID, mBase.address, root))
    // permissions
    await acl.createPermission(marketMaker.address, tokenManager.address, MINT_ROLE, root, { from: root })
    await acl.createPermission(marketMaker.address, tokenManager.address, BURN_ROLE, root, { from: root })
    await acl.createPermission(marketMaker.address, reserve.address, TRANSFER_ROLE, root, { from: root })
    await acl.createPermission(authorized, marketMaker.address, CONTROLLER_ROLE, root, { from: root })
    await acl.grantPermission(authorized2, marketMaker.address, CONTROLLER_ROLE, { from: root })
    // collaterals
    collateral = await TokenMock.new(authorized, INITIAL_TOKEN_BALANCE.mul(bn(2)))
    await collateral.transfer(authorized2, INITIAL_TOKEN_BALANCE, { from: authorized })
    collaterals = [ETH, collateral.address]
    // allowances
    await collateral.approve(marketMaker.address, INITIAL_TOKEN_BALANCE, { from: authorized })
    await collateral.approve(marketMaker.address, INITIAL_TOKEN_BALANCE, { from: authorized2 })
    // initializations
    await token.changeController(tokenManager.address)
    await tokenManager.initialize(token.address, true, 0)
    await reserve.initialize()
    await controller.initialize()
    await marketMaker.initialize(
      controller.address,
      tokenManager.address,
      formula.address,
      reserve.address,
      beneficiary,
      BUY_FEE_PERCENT,
      SELL_FEE_PERCENT
    )
    // end up initializing market maker
    await marketMaker.addCollateralToken(ETH, VIRTUAL_SUPPLIES[0], VIRTUAL_BALANCES[0], RESERVE_RATIOS[0], { from: authorized })
    await marketMaker.addCollateralToken(collateral.address, VIRTUAL_SUPPLIES[1], VIRTUAL_BALANCES[1], RESERVE_RATIOS[1], {
      from: authorized
    })

    if (open) {
      await marketMaker.open({ from: authorized })
    }

  }

  const purchaseReturn = async (index, supply, balance, amount) => {
    supply = bn(supply)
    balance = bn(balance)
    amount = bn(amount)

    return formula.calculatePurchaseReturn(VIRTUAL_SUPPLIES[index].add(supply), VIRTUAL_BALANCES[index].add(balance), RESERVE_RATIOS[index], amount)
  }

  const expectedPurchaseReturnForAmount = async (index, amount) => {
    const fee = computeBuyFee(amount)
    const amountNoFee = amount.sub(fee)

    const supply = await token.totalSupply()
    const balanceOfReserve = (await controller.balanceOf(reserve.address, collaterals[index])).add(amountNoFee)
    return await purchaseReturn(index, supply, balanceOfReserve, amountNoFee)
  }

  const saleReturn = async (index, supply, balance, amount) => {
    supply = bn(supply)
    balance = bn(balance)
    amount = bn(amount)

    return formula.calculateSaleReturn(VIRTUAL_SUPPLIES[index].add(supply), VIRTUAL_BALANCES[index].add(balance), RESERVE_RATIOS[index], amount)
  }

  const expectedSaleReturnForAmount = async (index, amount) => {
    const supply = (await token.totalSupply()).sub(amount)
    const balanceOfReserve = (await controller.balanceOf(reserve.address, collaterals[index]))
    const saleReturnAmount = await saleReturn(index, supply, balanceOfReserve, amount)

    const fee = await sellFeeAfterExchange(index, amount)
    return saleReturnAmount.sub(fee)
  }

  const sellFeeAfterExchange = async (index, amount) => {
    const supply = (await token.totalSupply()).sub(amount)
    const balanceOfReserve = (await controller.balanceOf(reserve.address, collaterals[index]))
    const saleReturnAmount = await saleReturn(index, supply, balanceOfReserve, amount)

    return computeSellFee(saleReturnAmount)
  }

  const computeBuyFee = amount => {
    amount = bn(amount)
    return amount
      .mul(BUY_FEE_PERCENT)
      .div(PCT_BASE)
  }

  const computeSellFee = amount => {
    amount = bn(amount)
    return amount
      .mul(SELL_FEE_PERCENT)
      .div(PCT_BASE)
  }

  const getCollateralToken = async collateral => {
    const {
      '0': whitelisted,
      '1': virtualSupply,
      '2': virtualBalance,
      '3': reserveRatio
     } = await marketMaker.getCollateralToken(collateral)

    return { whitelisted, virtualSupply, virtualBalance, reserveRatio }
  }

  const makeBuyOrder = async (buyer, collateral, paidAmount, minReturnAmount, opts = {}) => {
    const from = opts && opts.from ? opts.from : buyer
    const value = collateral === ETH ? (opts && opts.value ? opts.value : paidAmount) : opts && opts.value ? opts.value : 0
    return await marketMaker.makeBuyOrder(buyer, collateral, paidAmount, minReturnAmount, { from, value })
  }

  const makeSellOrder = async (seller, collateral, paidAmount, minReturnAmount, opts = {}) => {
    const from = opts && opts.from ? opts.from : seller
    return await marketMaker.makeSellOrder(seller, collateral, paidAmount, minReturnAmount, { from })
  }

  before(async () => {
    // formula
    formula = await Formula.new()
    // base contracts
    cBase = await Controller.new()
    tBase = await TokenManager.new()
    rBase = await Agent.new()
    mBase = await BancorMarketMaker.new()
    // constants
    TRANSFER_ROLE = await rBase.TRANSFER_ROLE()
    MINT_ROLE = await tBase.MINT_ROLE()
    BURN_ROLE = await tBase.BURN_ROLE()
    CONTROLLER_ROLE = await mBase.CONTROLLER_ROLE()
  })

  beforeEach(async () => {
    await initialize(true)
  })
  context('> #deploy', () => {
    it('> it should deploy', async () => {
      await BancorMarketMaker.new()
    })
  })

  context('> #initialize', () => {
    context('> initialization parameters are correct', () => {
      it('it should initialize batched bancor market maker', async () => {
        assert.equal(await marketMaker.controller(), controller.address)
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

      beforeEach(async() => {
        uninitialized = await BancorMarketMaker.at(await installNewApp(dao, MARKET_MAKER_ID, mBase.address, root))
      })

      it('it should revert [controller is not a contract]', async () => {
        await assertRevert(() =>
          uninitialized.initialize(
            authorized,
            tokenManager.address,
            formula.address,
            reserve.address,
            beneficiary,
            BUY_FEE_PERCENT,
            SELL_FEE_PERCENT,
            { from: root }
          ), 'MM_CONTRACT_IS_EOA'
        )
      })

      it('it should revert [token manager is not a contract]', async () => {
        await assertRevert(() =>
          uninitialized.initialize(
            controller.address,
            authorized,
            formula.address,
            reserve.address,
            beneficiary,
            BUY_FEE_PERCENT,
            SELL_FEE_PERCENT,
            { from: root }
          ), 'MM_CONTRACT_IS_EOA'
        )
      })

      it('it should revert [token manager setting is invalid]', async () => {
        const token_ = await MiniMeToken.new(ZERO_ADDRESS, ZERO_ADDRESS, 0, 'Bond', 18, 'BON', false)
        const tokenManager_ = await TokenManager.at(await installNewApp(dao, TOKEN_MANAGER_ID, tBase.address, root))

        await token_.changeController(tokenManager_.address)
        await tokenManager_.initialize(token_.address, true, 1)

        await assertRevert(() =>
          uninitialized.initialize(
            controller.address,
            tokenManager_.address,
            formula.address,
            reserve.address,
            beneficiary,
            BUY_FEE_PERCENT,
            SELL_FEE_PERCENT,
            { from: root }
          ), 'MM_INVALID_TM_SETTING'
        )
      })

      it('it should revert [reserve is not a contract]', async () => {
        await assertRevert(() =>
          uninitialized.initialize(
            controller.address,
            tokenManager.address,
            formula.address,
            authorized,
            beneficiary,
            BUY_FEE_PERCENT,
            SELL_FEE_PERCENT,
            {
              from: root
            }
          ), 'MM_CONTRACT_IS_EOA'
        )
      })

      it('it should revert [formula is not a contract]', async () => {
        await assertRevert(() =>
          uninitialized.initialize(
            controller.address,
            tokenManager.address,
            authorized,
            reserve.address,
            beneficiary,
            BUY_FEE_PERCENT,
            SELL_FEE_PERCENT,
            {
              from: root
            }
          ), 'MM_CONTRACT_IS_EOA'
        )
      })

      it('it should revert [beneficiary is null address]', async () => {
        await assertRevert(() =>
          uninitialized.initialize(
            controller.address,
            tokenManager.address,
            formula.address,
            reserve.address,
            ZERO_ADDRESS,
            BUY_FEE_PERCENT,
            SELL_FEE_PERCENT,
            {
              from: root
            }
          ), 'MM_INVALID_BENEFICIARY'
        )
      })

      it('it should revert [buy fee is not a percentage]', async () => {
        await assertRevert(() =>
          uninitialized.initialize(
            controller.address,
            tokenManager.address,
            formula.address,
            reserve.address,
            beneficiary,
            PCT_BASE,
            SELL_FEE_PERCENT,
            {
              from: root
            }
          ), 'MM_INVALID_PERCENTAGE'
        )
      })

      it('it should revert [sell fee is not a percentage]', async () => {
        await assertRevert(() =>
          uninitialized.initialize(
            controller.address,
            tokenManager.address,
            formula.address,
            reserve.address,
            beneficiary,
            BUY_FEE_PERCENT,
            PCT_BASE,
            {
              from: root
            }
          ), 'MM_INVALID_PERCENTAGE'
        )
      })
    })

    it('it should revert on re-initialization', async () => {
      await assertRevert(() =>
        marketMaker.initialize(
          controller.address,
          tokenManager.address,
          formula.address,
          reserve.address,
          beneficiary,
          BUY_FEE_PERCENT,
          SELL_FEE_PERCENT,
          { from: root }
        ), 'INIT_ALREADY_INITIALIZED'
      )
    })
  })

  context('> #open', () => {
    context('> sender has CONTROLLER_ROLE', () => {
      context('> and market making is not yet open', () => {
        beforeEach(async () => {
          await initialize(false)
        })

        it('it should open market making', async () => {
          const receipt = await marketMaker.open({ from: authorized })

          assertEvent(receipt, 'Open')
          assert.equal(await marketMaker.isOpen(), true)
        })
      })

      context('> but market making is already open', () => {
        it('it should revert', async () => {
          // market making is already open through the default initialize() script
          await assertRevert(() => marketMaker.open({ from: authorized }))
        })
      })
    })

    context('> sender does not have CONTROLLER_ROLE', () => {
      beforeEach(async () => {
        await initialize(false)
      })

      it('it should revert', async () => {
        await assertRevert(() => marketMaker.open({ from: unauthorized }))
      })
    })
  })

  context('> #addCollateralToken', () => {
    context('> sender has CONTROLLER_ROLE', () => {
      context('> and collateral token has not yet been added', () => {
        context('> and collateral token is ETH or ERC20 [i.e. contract]', () => {
          context('> and reserve ratio is valid', () => {
            it('it should add collateral token', async () => {
              const unlisted = await TokenMock.new(authorized, INITIAL_TOKEN_BALANCE)

              const virtualSupply = random.virtualSupply()
              const virtualBalance = random.virtualBalance()
              const reserveRatio = random.reserveRatio()

              const receipt = await marketMaker.addCollateralToken(unlisted.address, virtualSupply, virtualBalance, reserveRatio, {
                from: authorized
              })
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

              await assertRevert(() =>
                marketMaker.addCollateralToken(unlisted.address, random.virtualSupply(), random.virtualBalance(), PPM + 1, {
                  from: authorized
                })
              )
            })
          })
        })

        context('> but collateral token is not ETH or ERC20 [i.e. contract]', () => {
          it('it should revert', async () => {
            await assertRevert(() =>
              marketMaker.addCollateralToken(authorized, random.virtualSupply(), random.virtualBalance(), random.reserveRatio(), {
                from: authorized
              })
            )
          })
        })
      })

      context('> but collateral token has already been added', () => {
        it('it should revert', async () => {
          await assertRevert(() =>
            marketMaker.addCollateralToken(ETH, random.virtualSupply(), random.virtualBalance(), random.reserveRatio(), { from: authorized })
          )
        })
      })
    })

    context('> sender does not have CONTROLLER_ROLE', () => {
      it('it should revert', async () => {
        const unlisted = await TokenMock.new(authorized, INITIAL_TOKEN_BALANCE)

        await assertRevert(() =>
          marketMaker.addCollateralToken(unlisted.address, random.virtualSupply(), random.virtualBalance(), random.reserveRatio(), {
            from: unauthorized
          })
        )
      })
    })
  })

  context('> #removeCollateralToken', () => {
    context('> sender has CONTROLLER_ROLE', () => {
      context('> and collateral token is whitelisted', () => {
        it('it should remove collateral token', async () => {
          const receipt = await marketMaker.removeCollateralToken(collateral.address, { from: authorized })
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

          await assertRevert(() => marketMaker.removeCollateralToken(unlisted.address, { from: authorized }))
        })
      })
    })

    context('> sender does not have CONTROLLER_ROLE', () => {
      it('it should revert', async () => {
        await assertRevert(() => marketMaker.removeCollateralToken(collateral.address, { from: unauthorized }))
      })
    })
  })

  context('> #updateCollateralToken', () => {
    context('> sender has CONTROLLER_ROLE', () => {
      context('> and collateral token is whitelisted', () => {
        context('> and reserve ratio is valid', () => {
          it('it should update collateral token', async () => {
            const virtualSupply = random.virtualSupply()
            const virtualBalance = random.virtualBalance()
            const reserveRatio = random.reserveRatio()

            const receipt = await marketMaker.updateCollateralToken(collateral.address, virtualSupply, virtualBalance, reserveRatio, {
              from: authorized
            })
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
            await assertRevert(() =>
              marketMaker.updateCollateralToken(collateral.address, random.virtualSupply(), random.virtualBalance(), PPM + 1, {
                from: authorized
              })
            )
          })
        })
      })

      context('> but collateral token is not whitelisted', () => {
        it('it should revert', async () => {
          const unlisted = await TokenMock.new(authorized, INITIAL_TOKEN_BALANCE)

          await assertRevert(() =>
            marketMaker.updateCollateralToken(unlisted.address, random.virtualSupply(), random.virtualBalance(), random.reserveRatio(), {
              from: authorized
            })
          )
        })
      })
    })

    context('> sender does not have CONTROLLER_ROLE', () => {
      it('it should revert', async () => {
        await assertRevert(() =>
          marketMaker.updateCollateralToken(collateral.address, random.virtualSupply(), random.virtualBalance(), random.reserveRatio(), {
            from: unauthorized
          })
        )
      })
    })
  })

  context('> #updateBeneficiary', () => {
    context('> sender has CONTROLLER_ROLE', () => {
      context('> and beneficiary is valid', () => {
        it('it should update beneficiary', async () => {
          const receipt = await marketMaker.updateBeneficiary(root, { from: authorized })

          assertEvent(receipt, 'UpdateBeneficiary')
          assert.equal(await marketMaker.beneficiary(), root)
        })
      })

      context('> but beneficiary is not valid', () => {
        it('it should revert', async () => {
          await assertRevert(() => marketMaker.updateBeneficiary(ZERO_ADDRESS, { from: authorized }))
        })
      })
    })

    context('> sender does not have CONTROLLER_ROLE', () => {
      it('it should revert', async () => {
        await assertRevert(() => marketMaker.updateBeneficiary(root, { from: unauthorized }))
      })
    })
  })

  context('> #updateFormula', () => {
    context('> sender has CONTROLLER_ROLE', () => {
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
          await assertRevert(() => marketMaker.updateFormula(root, { from: authorized }))
        })
      })
    })

    context('> sender does not have CONTROLLER_ROLE', () => {
      it('it should revert', async () => {
        const formula_ = await Formula.new()

        await assertRevert(() => marketMaker.updateFormula(formula_.address, { from: unauthorized }))
      })
    })
  })

  context('> #updateFees', () => {
    context('> sender has CONTROLLER_ROLE', () => {
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
          await assertRevert(() => marketMaker.updateFees(PCT_BASE.add(bn(1)), 50, { from: authorized }))
        })

        it('it should revert [sell fee is not valid]', async () => {
          await assertRevert(() => marketMaker.updateFees(40, PCT_BASE.add(bn(1)), { from: authorized }))
        })
      })
    })

    context('> sender does not have CONTROLLER_ROLE', () => {
      it('it should revert', async () => {
        await assertRevert(() => marketMaker.updateFees(40, 50, { from: unauthorized }))
      })
    })
  })

  context('> #makeBuyOrder', () => {
    forEach(['ETH', 'ERC20']).describe(`> %s`, round => {
      const index = round === 'ETH' ? 0 : 1

      context('> sender has CONTROLLER_ROLE', () => {
        context('> and market making is open', () => {
          context('> and collateral is whitelisted', () => {
            context('> and value is not zero', () => {
              context('> and sender has sufficient funds', () => {
                context('> and no excess value is sent', () => {

                  it('it should make buy order', async () => {
                    const amount = random.amount()
                    const expectedReturnAmount = await expectedPurchaseReturnForAmount(index, amount)
                    const senderBalanceBefore = await token.balanceOf(authorized)

                    const receipt = await makeBuyOrder(authorized, collaterals[index], amount, expectedReturnAmount, { from: authorized })

                    const senderBalanceAfter = await token.balanceOf(authorized)
                    assertEvent(receipt, 'MakeBuyOrder')
                    assert.equal(senderBalanceAfter.sub(senderBalanceBefore).toString(), expectedReturnAmount.toString())
                  })

                  it('it should deduct fee', async () => {
                    const beneficiaryBalanceBefore = bn(await getBalance(collaterals[index], beneficiary))
                    const amount = random.amount()
                    const fee = computeBuyFee(amount)

                    await makeBuyOrder(authorized, collaterals[index], amount, 0, { from: authorized })

                    const beneficiaryBalanceAfter = bn(await getBalance(collaterals[index], beneficiary))
                    assertBn(beneficiaryBalanceAfter.sub(beneficiaryBalanceBefore), fee)
                  })

                  it('it should collect collateral', async () => {
                    const reserveBalanceBefore = bn(await getBalance(collaterals[index], reserve.address))
                    const amount = random.amount()
                    const fee = computeBuyFee(amount)
                    const amountAfterFee = amount.sub(fee)

                    await makeBuyOrder(authorized, collaterals[index], amount, 0, { from: authorized })

                    const reserveBalanceAfter = bn(await getBalance(collaterals[index], reserve.address))
                    assertBn(reserveBalanceAfter.sub(reserveBalanceBefore), amountAfterFee)
                  })

                  context('> but order returns less than min return amount', () => {
                    it('it should revert', async () => {
                      const amount = random.amount()
                      const expectedReturnAmount = bn(await expectedPurchaseReturnForAmount(index, amount))

                      await assertRevert(() =>
                        makeBuyOrder(authorized, collaterals[index], amount, expectedReturnAmount.add(bn(1)),
                          { from: authorized }), 'MM_SLIPPAGE_EXCEEDS_LIMIT')
                    })
                  })
                })

                context('> but excess value is sent', () => {
                  it('it should revert', async () => {
                    const amount = random.amount()

                    await assertRevert(() =>
                      makeBuyOrder(authorized, collaterals[index], amount, 0,
                        { from: authorized, value: amount.add(bn(1)) }), 'MM_INVALID_COLLATERAL_VALUE') // should revert both for ETH and ERC20
                  })
                })
              })

              context('> but sender does not have sufficient funds', () => {
                it('it should revert', async () => {
                  const amount = random.amount()
                  // let's burn the extra tokens to end up with a small balance
                  await collateral.transfer(unauthorized, INITIAL_TOKEN_BALANCE.sub(amount), { from: authorized })

                  await assertRevert(() =>
                    makeBuyOrder(authorized, collaterals[index], amount.add(bn(1)), 0,
                      { from: authorized, value: amount.sub(bn(1)) }), 'MM_INVALID_COLLATERAL_VALUE') // should revert both for ETH and ERC20
                })
              })
            })

            context('> but value is zero', () => {
              it('it should revert', async () => {
                await assertRevert(() =>
                  makeBuyOrder(authorized, collaterals[index], 0, 0,
                    { from: authorized }), 'MM_INVALID_COLLATERAL_VALUE')
              })
            })

          })

          context('> but collateral is not whitelisted', () => {
            it('it should revert', async () => {
              // we can't test un-whitelisted ETH unless we re-deploy a DAO without ETH as a whitelisted
              // collateral just for that use case it's not worth it because the logic is the same than ERC20 anyhow
              const unlisted = await TokenMock.new(authorized, INITIAL_TOKEN_BALANCE)
              await unlisted.approve(marketMaker.address, INITIAL_TOKEN_BALANCE, { from: authorized })
              await assertRevert(() => makeBuyOrder(authorized, unlisted.address, random.amount(), 0, { from: authorized }),
                'MM_COLLATERAL_NOT_WHITELISTED')
            })
          })
        })

        context('> but market making is not open', () => {
          beforeEach(async () => {
            await initialize(false)
          })

          it('it should revert', async () => {
            await assertRevert(() => makeBuyOrder(authorized, collaterals[index], random.amount(), 0, { from: authorized }),
              'MM_NOT_OPEN')
          })
        })
      })

      context('> sender does not have CONTROLLER_ROLE', () => {
        it('it should revert', async () => {
          await assertRevert(() => makeBuyOrder(unauthorized, collaterals[index], random.amount(), 0, { from: unauthorized }),
            'APP_AUTH_FAILED')
        })
      })
    })
  })

  context('> #makeSellOrder', () => {
    // forEach(['ETH']).describe(`> %s`, round => {
      forEach(['ETH', 'ERC20']).describe(`> %s`, round => {
      const index = round === 'ETH' ? 0 : 1

      context('> sender has CONTROLLER_ROLE', () => {
        context('> and market making is open', () => {
          context('> and collateral is whitelisted', () => {
            context('> and amount is not zero', () => {
              context('> and sender has sufficient funds', () => {
                context('> and pool has sufficient funds', () => {
                  context('> and there is one order', () => {

                    it('it should make sell order', async () => {
                      await makeBuyOrder(authorized, collaterals[index], random.amount(), 0, { from: authorized })

                      const collateralBalanceBefore = index === 0 ? bn(await web3.eth.getBalance(authorized)) : bn(await collateral.balanceOf(authorized))
                      const tokenBalanceBefore = await token.balanceOf(authorized)
                      const expectedSaleReturn = await expectedSaleReturnForAmount(index, tokenBalanceBefore)

                      const sellReceipt = await makeSellOrder(authorized, collaterals[index], tokenBalanceBefore, expectedSaleReturn, { from: authorized2 })

                      const tokenBalanceAfter = await token.balanceOf(authorized)
                      const collateralBalanceAfter = index === 0 ? bn(await web3.eth.getBalance(authorized)) : bn(await collateral.balanceOf(authorized))
                      const collateralReturned = collateralBalanceAfter.sub(collateralBalanceBefore)

                      assertEvent(sellReceipt, 'MakeSellOrder')
                      assertBn(tokenBalanceAfter, 0)
                      assertBn(await token.totalSupply(), 0)
                      assertBn(collateralReturned, expectedSaleReturn)
                    })

                    it('it should collect fees', async () => {
                      await makeBuyOrder(authorized, collaterals[index], random.amount(), 0, { from: authorized })
                      const senderBalance = await token.balanceOf(authorized)
                      const beneficiaryBalanceBefore = index === 0 ? bn(await web3.eth.getBalance(beneficiary)) : bn(await collateral.balanceOf(beneficiary))
                      const fee = await sellFeeAfterExchange(index, senderBalance)

                      await makeSellOrder(authorized, collaterals[index], senderBalance, 0, { from: authorized })

                      const beneficiaryBalanceAfter = index === 0 ? bn(await web3.eth.getBalance(beneficiary)) : bn(await collateral.balanceOf(beneficiary))
                      assertBn(beneficiaryBalanceAfter.sub(beneficiaryBalanceBefore), fee)
                    })

                  })
                })

                context('> but pool does not have sufficient funds', () => {
                  it('it should revert', async () => {
                    const index_ = index === 1 ? 0 : 1
                    // let's add some collateral into the pool

                    await makeBuyOrder(authorized, collaterals[index], random.amount(), 0, { from: authorized })
                    await makeBuyOrder(authorized, collaterals[index_], random.amount(), 0, { from: authorized })
                    const senderBalance = await token.balanceOf(authorized)

                    // redeem more bonds against the base collateral than it can pay for and assert it reverts
                    await assertRevert(() => makeSellOrder(authorized, collaterals[index], senderBalance,
                      0, { from: authorized }), index === 0 ? "VAULT_SEND_REVERTED" : "VAULT_TOKEN_TRANSFER_REVERTED")
                  })
                })


                context('> but order returns less than minReturnAmount', () => {
                  it('it should revert', async () => {
                    await makeBuyOrder(authorized, collaterals[index], random.amount(), 0, { from: authorized })
                    const senderBalance = await token.balanceOf(authorized)

                    const expectedSaleReturn = await expectedSaleReturnForAmount(index, senderBalance)

                    await assertRevert(() => makeSellOrder(authorized, collaterals[index], senderBalance,
                      expectedSaleReturn.add(bn(1)), { from: authorized }), "MM_SLIPPAGE_EXCEEDS_LIMIT")
                  })
                })
              })

              context('> but sender does not have sufficient funds', () => {
                it('it should revert', async () => {
                  await makeBuyOrder(authorized, collaterals[index], random.amount(), 0, { from: authorized })
                  const senderBalance = await token.balanceOf(authorized)

                  await assertRevert(() => makeSellOrder(authorized, collaterals[index], senderBalance.add(bn(1)),
                    0, { from: authorized }), "MM_INVALID_BOND_AMOUNT")
                })
              })
            })

            context('> but amount is zero', () => {
              it('it should revert', async () => {
                await makeBuyOrder(authorized, collaterals[index], random.amount(), 0, { from: authorized })

                await assertRevert(() => makeSellOrder(authorized, collaterals[index], 0,
                  0, { from: authorized }), "MM_INVALID_BOND_AMOUNT")
              })
            })

          })

          context('> but collateral is not whitelisted', () => {
            it('it should revert', async () => {
              // we can't test un-whitelisted ETH unless we re-deploy a DAO without ETH as a whitelisted
              // collateral just for that use case it's not worth it because the logic is the same than ERC20 anyhow
              const unlisted = await TokenMock.new(authorized, INITIAL_TOKEN_BALANCE)
              await unlisted.approve(marketMaker.address, INITIAL_TOKEN_BALANCE, { from: authorized })
              await makeBuyOrder(authorized, collaterals[index], random.amount(), 0, { from: authorized })
              const senderBalance = await token.balanceOf(authorized)

              await assertRevert(() => makeSellOrder(authorized, unlisted.address, senderBalance,
                0, { from: authorized }), "MM_COLLATERAL_NOT_WHITELISTED")
            })
          })
        })

        context('> but market making is not open', () => {
          it('it should revert', async () => {
            // can't test cause we need the market making to be open to have bonds to redeem
          })
        })
      })

      context('> sender does not have CONTROLLER_ROLE', () => {
        it('it should revert', async () => {
          await makeBuyOrder(authorized, collaterals[index], random.amount(), 0, { from: authorized })
          const senderBalance = await token.balanceOf(authorized)

          await assertRevert(() => makeSellOrder(authorized, collaterals[index], senderBalance,
            0, { from: unauthorized }), "APP_AUTH_FAILED")
        })
      })
    })
  })

  context('> #makeBuyOrderRaw', () => {

    let amount

    beforeEach(async () => {
      amount = random.amount()
      await collateral.transfer(marketMaker.address, amount, { from: authorized })
    })

    it('successfully calls makeBuyOrderRaw()', async () => {
      const makeBuyOrderData = marketMaker.contract.methods.makeBuyOrder(authorized, collaterals[1], amount, 0).encodeABI()

      const receipt = await marketMaker.makeBuyOrderRaw(authorized, collaterals[1], amount, makeBuyOrderData, { from: authorized })

      assertEvent(receipt, 'MakeBuyOrder')
    })

    it('reverts when does not have CONTROLLER_ROLE', async () => {
      const makeBuyOrderData = marketMaker.contract.methods.makeBuyOrder(authorized, collaterals[1], amount, 0).encodeABI()
      await acl.revokePermission(authorized, marketMaker.address, CONTROLLER_ROLE, { from: root })

      await assertRevert(marketMaker.makeBuyOrderRaw(authorized, collaterals[1], amount, makeBuyOrderData, { from: authorized }),
        "APP_AUTH_FAILED")
    })

    it('reverts when data is for function other than makeBuyOrder', async () => {
      const makeBuyOrderData = marketMaker.contract.methods.makeSellOrder(authorized, collaterals[1], amount, 0).encodeABI()

      await assertRevert(marketMaker.makeBuyOrderRaw(authorized, collaterals[1], amount, makeBuyOrderData, { from: authorized }),
        "MM_NOT_BUY_FUNCTION")
    })

    it('reverts when buyer in data is not equal to from address', async () => {
      const makeBuyOrderData = marketMaker.contract.methods.makeBuyOrder(authorized2, collaterals[1], amount, 0).encodeABI()

      await assertRevert(marketMaker.makeBuyOrderRaw(authorized, collaterals[1], amount, makeBuyOrderData, { from: authorized }),
        "MM_BUYER_NOT_FROM")
    })

    it('reverts when collateral in data is not equal to token address', async () => {
      const makeBuyOrderData = marketMaker.contract.methods.makeBuyOrder(authorized, authorized, amount, 0).encodeABI()

      await assertRevert(marketMaker.makeBuyOrderRaw(authorized, collaterals[1], amount, makeBuyOrderData, { from: authorized }),
        "MM_COLLATERAL_NOT_SENDER")
    })

    it('reverts when deposit amount in data is not equal to token amount', async () => {
      const makeBuyOrderData = marketMaker.contract.methods.makeBuyOrder(authorized, collaterals[1], amount.add(bn(1)), 0).encodeABI()

      await assertRevert(marketMaker.makeBuyOrderRaw(authorized, collaterals[1], amount, makeBuyOrderData, { from: authorized }),
        "MM_DEPOSIT_NOT_AMOUNT")
    })
  })
  

})
