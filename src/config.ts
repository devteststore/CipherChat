interface NetworkConfig {
  lightwalletdUrl: string
  lightwalletdPort: number
  explorerUrl: string
  coinType: number
  hrp: string
  dustAmount: number
  blockTime: number
}

export const config: NetworkConfig = {
  lightwalletdUrl: 'https://mainnet.lightwalletd.com',
  lightwalletdPort: 9067,
  explorerUrl: 'https://zcashexplorer.app',
  coinType: 133,
  hrp: 'u',
  dustAmount: 1000,
  blockTime: 75,
}
