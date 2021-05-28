const sha3 = require('js-sha3').keccak_256

module.exports = assertExternalEvent = (receipt, eventName, instances = 1) => {
  const logs = (receipt.receipt && receipt.receipt.rawLogs) || []
  const events = logs.filter(l => {
    return l.topics[0] === '0x' + sha3(eventName)
  })
  assert.equal(
    events.length,
    instances,
    `'${eventName}' event should have been fired ${instances} times`
  )
  return events
}
