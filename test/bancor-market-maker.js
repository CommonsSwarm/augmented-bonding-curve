const Kernel = artifacts.require('Kernel')
const ACL = artifacts.require('ACL')
const EVMScriptRegistryFactory = artifacts.require('EVMScriptRegistryFactory')
const DAOFactory = artifacts.require('DAOFactory')
const MiniMeToken = artifacts.require('MiniMeToken')
const Controller = artifacts.require('AragonFundraisingControllerMock')
const TokenManager = artifacts.require('TokenManager')
const Agent = artifacts.require('Agent')
const Formula = artifacts.require('BancorFormula')
const BancorMarketMaker = artifacts.require('BancorMarketMaker')
const TokenMock = artifacts.require('TokenMock')

const assertEvent = require('@aragon/test-helpers/assertEvent')
const { assertRevert } = require('@aragon/test-helpers/assertThrow')
const getBalance = require('@ablack/fundraising-shared-test-helpers/getBalance')(web3, TokenMock)
const { ZERO_ADDRESS } = require('@ablack/fundraising-shared-test-helpers/constants')
const { getEvent } = require('@ablack/fundraising-shared-test-helpers/events')
const random = require('@ablack/fundraising-shared-test-helpers/random')

const { hash } = require('eth-ens-namehash')
const forEach = require('mocha-each')

const RESERVE_ID = hash('agent.aragonpm.eth')
const TOKEN_MANAGER_ID = hash('token-manager.aragonpm.eth')
const CONTROLLER_ID = hash('marketplace-controller.aragonpm.eth')
const MARKET_MAKER_ID = hash('bancor-market-maker.aragonpm.eth')

const INITIAL_TOKEN_BALANCE = 10000 * Math.pow(10, 18) // 10000 DAIs or ANTs
const PPM = 1000000
const PCT_BASE = 1000000000000000000

const BUY_FEE_PERCENT = 100000000000000000 // 1%
const SELL_FEE_PERCENT = 100000000000000000

const VIRTUAL_SUPPLIES = [new web3.BigNumber(Math.pow(10, 23)), new web3.BigNumber(Math.pow(10, 22))]
const VIRTUAL_BALANCES = [new web3.BigNumber(Math.pow(10, 22)), new web3.BigNumber(Math.pow(10, 20))]
const RESERVE_RATIOS = [(PPM * 10) / 100, (PPM * 1) / 100]

const { ETH } = require('@ablack/fundraising-shared-test-helpers/constants')

contract('BatchedBancorMarketMaker app', accounts => {
  let factory, dao, acl, cBase, tBase, rBase, mBase, token, tokenManager, controller, reserve, formula, marketMaker,
    collateral, collaterals
  let APP_MANAGER_ROLE,
    MINT_ROLE,
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
    const dReceipt = await factory.newDAO(root)
    dao = await Kernel.at(getEvent(dReceipt, 'DeployDAO', 'dao'))
    acl = await ACL.at(await dao.acl())
    await acl.createPermission(root, dao.address, APP_MANAGER_ROLE, root, { from: root })
    // token
    token = await MiniMeToken.new(ZERO_ADDRESS, ZERO_ADDRESS, 0, 'Bond', 18, 'BON', false)
    // market maker controller
    const cReceipt = await dao.newAppInstance(CONTROLLER_ID, cBase.address, '0x', false)
    controller = await Controller.at(getEvent(cReceipt, 'NewAppProxy', 'proxy'))
    // token manager
    const tReceipt = await dao.newAppInstance(TOKEN_MANAGER_ID, tBase.address, '0x', false)
    tokenManager = await TokenManager.at(getEvent(tReceipt, 'NewAppProxy', 'proxy'))
    // pool
    const pReceipt = await dao.newAppInstance(RESERVE_ID, rBase.address, '0x', false)
    reserve = await Agent.at(getEvent(pReceipt, 'NewAppProxy', 'proxy'))
    // bancor-curve
    const bReceipt = await dao.newAppInstance(MARKET_MAKER_ID, mBase.address, '0x', false)
    marketMaker = await BancorMarketMaker.at(getEvent(bReceipt, 'NewAppProxy', 'proxy'))
    // permissions
    await acl.createPermission(marketMaker.address, tokenManager.address, MINT_ROLE, root, { from: root })
    await acl.createPermission(marketMaker.address, tokenManager.address, BURN_ROLE, root, { from: root })
    await acl.createPermission(marketMaker.address, reserve.address, TRANSFER_ROLE, root, { from: root })
    await acl.createPermission(authorized, marketMaker.address, CONTROLLER_ROLE, root, { from: root })
    await acl.grantPermission(authorized2, marketMaker.address, CONTROLLER_ROLE, { from: root })
    // collaterals
    collateral = await TokenMock.new(authorized, INITIAL_TOKEN_BALANCE * 2)
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

  const BN = amount => {
    return new web3.BigNumber(amount)
  }

  const purchaseReturn = async (index, supply, balance, amount) => {
    supply = new web3.BigNumber(supply.toString(10))
    balance = new web3.BigNumber(balance.toString(10))
    amount = new web3.BigNumber(amount.toString(10))

    return formula.calculatePurchaseReturn(VIRTUAL_SUPPLIES[index].add(supply), VIRTUAL_BALANCES[index].add(balance), RESERVE_RATIOS[index], amount)
  }

  const expectedPurchaseReturnForAmount = async (index, amount) => {
    const fee = computeBuyFee(amount)
    const amountNoFee = amount.minus(fee)

    const supply = await token.totalSupply()
    const balanceOfReserve = (await controller.balanceOf(reserve.address, collaterals[index])).add(amountNoFee)
    return await purchaseReturn(index, supply, balanceOfReserve, amountNoFee)
  }

  const saleReturn = async (index, supply, balance, amount) => {
    supply = new web3.BigNumber(supply.toString(10))
    balance = new web3.BigNumber(balance.toString(10))
    amount = new web3.BigNumber(amount.toString(10))

    return formula.calculateSaleReturn(VIRTUAL_SUPPLIES[index].add(supply), VIRTUAL_BALANCES[index].add(balance), RESERVE_RATIOS[index], amount)
  }

  const expectedSaleReturnForAmount = async (index, amount) => {
    const supply = (await token.totalSupply()).minus(amount)
    const balanceOfReserve = (await controller.balanceOf(reserve.address, collaterals[index]))
    const saleReturnAmount = await saleReturn(index, supply, balanceOfReserve, amount)

    const fee = await sellFeeAfterExchange(index, amount)
    return saleReturnAmount.minus(fee)
  }

  const sellFeeAfterExchange = async (index, amount) => {
    const supply = (await token.totalSupply()).minus(amount)
    const balanceOfReserve = (await controller.balanceOf(reserve.address, collaterals[index]))
    const saleReturnAmount = await saleReturn(index, supply, balanceOfReserve, amount)

    return computeSellFee(saleReturnAmount)
  }

  const computeBuyFee = amount => {
    amount = new web3.BigNumber(amount.toString(10))
    return amount
      .times(BUY_FEE_PERCENT)
      .div(PCT_BASE)
      .round(0)
  }

  const computeSellFee = amount => {
    amount = new web3.BigNumber(amount.toString(10))
    return amount
      .times(SELL_FEE_PERCENT)
      .div(PCT_BASE)
      .round(0)
  }

  const getCollateralToken = async collateral => {
    const [whitelisted, virtualSupply, virtualBalance, reserveRatio] = await marketMaker.getCollateralToken(collateral)

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
    // factory
    const kBase = await Kernel.new(true) // petrify immediately
    const aBase = await ACL.new()
    const rFact = await EVMScriptRegistryFactory.new()
    factory = await DAOFactory.new(kBase.address, aBase.address, rFact.address)
    // formula
    formula = await Formula.new()
    // base contracts
    cBase = await Controller.new()
    tBase = await TokenManager.new()
    rBase = await Agent.new()
    mBase = await BancorMarketMaker.new()
    // constants
    APP_MANAGER_ROLE = await kBase.APP_MANAGER_ROLE()
    TRANSFER_ROLE = await rBase.TRANSFER_ROLE()
    MINT_ROLE = await tBase.MINT_ROLE()
    BURN_ROLE = await tBase.BURN_ROLE()
    CONTROLLER_ROLE = await mBase.CONTROLLER_ROLE()
  })

  beforeEach(async () => {
    await initialize(true)
  })

  // #region deploy
  context('> #deploy', () => {
    it('> it should deploy', async () => {
      await BancorMarketMaker.new()
    })
  })
  // #endregion

  // #region initialize
  context('> #initialize', () => {
    context('> initialization parameters are correct', () => {
      it('it should initialize batched bancor market maker', async () => {
        assert.equal(await marketMaker.controller(), controller.address)
        assert.equal(await marketMaker.tokenManager(), tokenManager.address)
        assert.equal(await marketMaker.token(), token.address)
        assert.equal(await marketMaker.reserve(), reserve.address)
        assert.equal(await marketMaker.beneficiary(), beneficiary)
        assert.equal(await marketMaker.formula(), formula.address)
        assert.equal(await marketMaker.buyFeePct(), BUY_FEE_PERCENT)
        assert.equal(await marketMaker.sellFeePct(), SELL_FEE_PERCENT)
      })
    })

    context('> initialization parameters are not correct', () => {
      it('it should revert [controller is not a contract]', async () => {
        const bReceipt = await dao.newAppInstance(MARKET_MAKER_ID, mBase.address, '0x', false)
        const uninitialized = await BancorMarketMaker.at(getEvent(bReceipt, 'NewAppProxy', 'proxy'))

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
        const bReceipt = await dao.newAppInstance(MARKET_MAKER_ID, mBase.address, '0x', false)
        const uninitialized = await BancorMarketMaker.at(getEvent(bReceipt, 'NewAppProxy', 'proxy'))

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
        const bReceipt = await dao.newAppInstance(MARKET_MAKER_ID, mBase.address, '0x', false)
        const uninitialized = await BancorMarketMaker.at(getEvent(bReceipt, 'NewAppProxy', 'proxy'))

        const token_ = await MiniMeToken.new(ZERO_ADDRESS, ZERO_ADDRESS, 0, 'Bond', 18, 'BON', false)
        const tReceipt_ = await dao.newAppInstance(TOKEN_MANAGER_ID, tBase.address, '0x', false)
        const tokenManager_ = await TokenManager.at(getEvent(tReceipt_, 'NewAppProxy', 'proxy'))

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
        const bReceipt = await dao.newAppInstance(MARKET_MAKER_ID, mBase.address, '0x', false)
        const uninitialized = await BancorMarketMaker.at(getEvent(bReceipt, 'NewAppProxy', 'proxy'))

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
        const bReceipt = await dao.newAppInstance(MARKET_MAKER_ID, mBase.address, '0x', false)
        const uninitialized = await BancorMarketMaker.at(getEvent(bReceipt, 'NewAppProxy', 'proxy'))

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
        const bReceipt = await dao.newAppInstance(MARKET_MAKER_ID, mBase.address, '0x', false)
        const uninitialized = await BancorMarketMaker.at(getEvent(bReceipt, 'NewAppProxy', 'proxy'))

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
        const bReceipt = await dao.newAppInstance(MARKET_MAKER_ID, mBase.address, '0x', false)
        const uninitialized = await BancorMarketMaker.at(getEvent(bReceipt, 'NewAppProxy', 'proxy'))

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
        const bReceipt = await dao.newAppInstance(MARKET_MAKER_ID, mBase.address, '0x', false)
        const uninitialized = await BancorMarketMaker.at(getEvent(bReceipt, 'NewAppProxy', 'proxy'))

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
  // #endregion

  // #region open
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
  // #endregion

  // #region addCollateralToken
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
              assert.equal(collateral.virtualSupply.toNumber(), virtualSupply)
              assert.equal(collateral.virtualBalance.toNumber(), virtualBalance)
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
  // #endregion

  // #region removeCollateralToken
  context('> #removeCollateralToken', () => {
    context('> sender has CONTROLLER_ROLE', () => {
      context('> and collateral token is whitelisted', () => {
        it('it should remove collateral token', async () => {
          const receipt = await marketMaker.removeCollateralToken(collateral.address, { from: authorized })
          const collateral_ = await getCollateralToken(collateral.address)

          assertEvent(receipt, 'RemoveCollateralToken')
          assert.equal(collateral_.whitelisted, false)
          assert.equal(collateral_.virtualSupply.toNumber(), 0)
          assert.equal(collateral_.virtualBalance.toNumber(), 0)
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
  // #endregion

  // #region updateCollateralToken
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
            assert.equal(collateral_.virtualSupply.toNumber(), virtualSupply)
            assert.equal(collateral_.virtualBalance.toNumber(), virtualBalance)
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
  // #endregion

  // #region updateBeneficiary
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
  // #endregion

  // #region updateFormula
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
  // #endregion

  // #region updateFees
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
          await assertRevert(() => marketMaker.updateFees(PCT_BASE + 1, 50, { from: authorized }))
        })

        it('it should revert [sell fee is not valid]', async () => {
          await assertRevert(() => marketMaker.updateFees(40, PCT_BASE + 1, { from: authorized }))
        })
      })
    })

    context('> sender does not have CONTROLLER_ROLE', () => {
      it('it should revert', async () => {
        await assertRevert(() => marketMaker.updateFees(40, 50, { from: unauthorized }))
      })
    })
  })
  // #endregion

  // #region makeBuyOrder
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
                    assert.equal(senderBalanceAfter.minus(senderBalanceBefore).toString(), expectedReturnAmount.toString())
                  })

                  it('it should deduct fee', async () => {
                    const beneficiaryBalanceBefore = await getBalance(collaterals[index], beneficiary)
                    const amount = random.amount()
                    const fee = computeBuyFee(amount)

                    await makeBuyOrder(authorized, collaterals[index], amount, 0, { from: authorized })

                    const beneficiaryBalanceAfter = await getBalance(collaterals[index], beneficiary)
                    assert.equal(beneficiaryBalanceAfter.minus(beneficiaryBalanceBefore).toNumber(), fee.toNumber())
                  })

                  it('it should collect collateral', async () => {
                    const reserveBalanceBefore = await getBalance(collaterals[index], reserve.address)
                    const amount = random.amount()
                    const fee = computeBuyFee(amount)
                    const amountAfterFee = amount.minus(fee)

                    await makeBuyOrder(authorized, collaterals[index], amount, 0, { from: authorized })

                    const reserveBalanceAfter = await getBalance(collaterals[index], reserve.address)
                    assert.equal(reserveBalanceAfter.minus(reserveBalanceBefore).toNumber(), amountAfterFee.toNumber())
                  })

                  context('> but order returns less than min return amount', () => {
                    it('it should revert', async () => {
                      const amount = random.amount()
                      const expectedReturnAmount = await expectedPurchaseReturnForAmount(index, amount)

                      await assertRevert(() =>
                        makeBuyOrder(authorized, collaterals[index], amount, expectedReturnAmount.add(1),
                          { from: authorized }), 'MM_SLIPPAGE_EXCEEDS_LIMIT')
                    })
                  })
                })

                context('> but excess value is sent', () => {
                  it('it should revert', async () => {
                    const amount = random.amount()

                    await assertRevert(() =>
                      makeBuyOrder(authorized, collaterals[index], amount, 0,
                        { from: authorized, value: amount.add(1) }), 'MM_INVALID_COLLATERAL_VALUE') // should revert both for ETH and ERC20
                  })
                })
              })

              context('> but sender does not have sufficient funds', () => {
                it('it should revert', async () => {
                  const amount = random.amount()
                  // let's burn the extra tokens to end up with a small balance
                  await collateral.transfer(unauthorized, INITIAL_TOKEN_BALANCE - amount, { from: authorized })

                  await assertRevert(() =>
                    makeBuyOrder(authorized, collaterals[index], amount.add(1), 0,
                      { from: authorized, value: amount.minus(1) }), 'MM_INVALID_COLLATERAL_VALUE') // should revert both for ETH and ERC20
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
  // #endregion

  // #region makeSellOrder
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

                      const collateralBalanceBefore = index === 0 ? web3.eth.getBalance(authorized) : await collateral.balanceOf(authorized)
                      const tokenBalanceBefore = await token.balanceOf(authorized)
                      const expectedSaleReturn = await expectedSaleReturnForAmount(index, tokenBalanceBefore)

                      const sellReceipt = await makeSellOrder(authorized, collaterals[index], tokenBalanceBefore, expectedSaleReturn, { from: authorized2 })

                      const tokenBalanceAfter = await token.balanceOf(authorized)
                      const collateralBalanceAfter = index === 0 ? web3.eth.getBalance(authorized) : await collateral.balanceOf(authorized)
                      const collateralReturned = collateralBalanceAfter.minus(collateralBalanceBefore)

                      assertEvent(sellReceipt, 'OpenSellOrder')
                      assert.equal(tokenBalanceAfter.toString(), 0)
                      assert.equal((await token.totalSupply()).toNumber(), 0)
                      assert.equal(collateralReturned.toString(), expectedSaleReturn.toString())
                    })

                    it('it should collect fees', async () => {
                      await makeBuyOrder(authorized, collaterals[index], random.amount(), 0, { from: authorized })
                      const senderBalance = await token.balanceOf(authorized)
                      const beneficiaryBalanceBefore = index === 0 ? web3.eth.getBalance(beneficiary) : await collateral.balanceOf(beneficiary)
                      const fee = await sellFeeAfterExchange(index, senderBalance)

                      await makeSellOrder(authorized, collaterals[index], senderBalance, 0, { from: authorized })

                      const beneficiaryBalanceAfter = index === 0 ? web3.eth.getBalance(beneficiary) : await collateral.balanceOf(beneficiary)
                      assert.equal(beneficiaryBalanceAfter.minus(beneficiaryBalanceBefore).toString(), fee.toString())
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
                      expectedSaleReturn.add(1), { from: authorized }), "MM_SLIPPAGE_EXCEEDS_LIMIT")
                  })
                })
              })

              context('> but sender does not have sufficient funds', () => {
                it('it should revert', async () => {
                  await makeBuyOrder(authorized, collaterals[index], random.amount(), 0, { from: authorized })
                  const senderBalance = await token.balanceOf(authorized)

                  await assertRevert(() => makeSellOrder(authorized, collaterals[index], senderBalance.add(1),
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
  // #endregion

})
