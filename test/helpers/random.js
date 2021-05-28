const { bigExp } = require('@aragon/contract-helpers-test/src/numbers')

module.exports = {
  amount: () => {
    return bigExp(Math.floor(Math.random() * 10 + 1), 18)
  },

  virtualSupply: () => {
    return bigExp(Math.floor(Math.random() * 10 ** 8), 10)
  },

  virtualBalance: () => {
    return bigExp(Math.floor(Math.random() * 10 ** 8), 10)
  },

  reserveRatio: () => {
    return Math.floor(Math.random() * 999999) + 1
  },

  slippage: () => {
    return bigExp(Math.floor(Math.random() * 10 ** 8), 10)
  },

  rate: () => {
    return Math.floor(Math.random() * 999) + 1
  },

  floor: () => {
    return Math.floor(Math.random() * 999999) + 1
  },

  fee: () => {
    return bigExp(Math.floor(Math.random() * 10 ** 7, 10))
  },
}
