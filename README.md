# GlobalSwap UI Setup

## Setup sdk core page
- Clone https://github.com/shardeum-globalswap/globalswap-sdk.git
- Open src/constants.ts file and update `FACTORY_ADDRESS`, `INIT_CODE_HASH`, `ChainId` as needed
- Rebuild the changes with `npm run build`
- Locally link with `npm link`

## Setup default-token-list
- Clone https://github.com/shardeum-globalswap/default-token-list.git
- Open src/tokens/shardeum.json file and update the token information as needed
- Rebuild the changes with `npm run build`
- Locally link with `npm link`

## Start GlobalSwap UI
- Clone global swap interface repo. https://github.com/shardeum-globalswap/interface.git
- Open `src/constants/index.ts` file and update `FACTORY_ADDRESS` and `ROUTER_ADDRESS`
- Open `src/constants/multicall/index.ts` file and update multicall contract address for shardeum
- Install witn `npm install`
- Link sdk core `npm link @uniswap/sdk`
- Link default token list `npm link @uniswap-default-token-list`
- Start dev server `npm start`
