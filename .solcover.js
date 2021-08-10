module.exports = {
  norpc: true,
  copyPackages: [
    '@aragon/os',
    '@aragon/contract-helpers-test',
    '@aragon/minime',
    '@aragon/apps-agent',
    '@aragon/apps-token-manager',
    '@aragon/apps-vault',
    '@ablack/fundraising-bancor-formula',
  ],
  skipFiles: [
    'test',
    '@aragon/os',
    '@aragon/contract-helpers-test',
    '@aragon/minime',
    '@aragon/apps-agent',
    '@aragon/apps-token-manager',
    '@aragon/apps-vault',
    '@ablack/fundraising-bancor-formula',
  ],
}
