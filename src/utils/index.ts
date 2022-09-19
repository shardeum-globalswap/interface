import { Contract } from '@ethersproject/contracts';
import { getAddress } from '@ethersproject/address';
import { AddressZero } from '@ethersproject/constants';
import { JsonRpcSigner, Web3Provider } from '@ethersproject/providers';
import { BigNumber } from '@ethersproject/bignumber';
import { abi as IUniswapV2Router02ABI } from '@uniswap/v2-periphery/build/IUniswapV2Router02.json';
import { abi as factoryABI } from '@uniswap/v2-core/build/IUniswapV2Factory.json';
import { abi as pairABI } from '@uniswap/v2-core/build/IUniswapV2Pair.json';
import { ROUTER_ADDRESS, ammAddresses } from '../constants';
import { ChainId, Currency, CurrencyAmount, ETHER, JSBI, Percent, Token } from '@uniswap/sdk';
import { TokenAddressMap } from '../state/lists/hooks';
import { ethers } from 'ethers';
import Web3 from 'web3';

const codeHashMap: any = new Map();
codeHashMap.set(ammAddresses.wethAddress, ammAddresses.wethCodeHash);
codeHashMap.set(ammAddresses.daiAddress, ammAddresses.daiCodeHash);

// returns the checksummed address if the address is valid, otherwise returns false
export function isAddress(value: any): string | false {
  try {
    return getAddress(value);
  } catch {
    return false;
  }
}

const ETHERSCAN_PREFIXES: { [chainId in ChainId]: string } = {
  1: '',
  3: 'ropsten.',
  4: 'rinkeby.',
  5: 'goerli.',
  42: 'kovan.',
  8081: 'shardeum',
};

export function getEtherscanLink(
  chainId: ChainId,
  data: string,
  type: 'transaction' | 'token' | 'address' | 'block'
): string {
  const prefix = `https://explorer.liberty20.shardeum.org`;

  switch (type) {
    case 'transaction': {
      return `${prefix}/tx/${data}`;
    }
    case 'token': {
      return `${prefix}/token/${data}`;
    }
    case 'block': {
      return `${prefix}/block/${data}`;
    }
    case 'address':
    default: {
      return `${prefix}/address/${data}`;
    }
  }
}

// shorten the checksummed version of the input address to have 0x + 4 characters at start and end
export function shortenAddress(address: string, chars = 4): string {
  const parsed = isAddress(address);
  if (!parsed) {
    throw Error(`Invalid 'address' parameter '${address}'.`);
  }
  return `${parsed.substring(0, chars + 2)}...${parsed.substring(42 - chars)}`;
}

// add 10%
export function calculateGasMargin(value: BigNumber): BigNumber {
  return value.mul(BigNumber.from(10000).add(BigNumber.from(1000))).div(BigNumber.from(10000));
}

// converts a basis points value to a sdk percent
export function basisPointsToPercent(num: number): Percent {
  return new Percent(JSBI.BigInt(num), JSBI.BigInt(10000));
}

export function calculateSlippageAmount(value: CurrencyAmount, slippage: number): [JSBI, JSBI] {
  if (slippage < 0 || slippage > 10000) {
    throw Error(`Unexpected slippage value: ${slippage}`);
  }
  return [
    JSBI.divide(JSBI.multiply(value.raw, JSBI.BigInt(10000 - slippage)), JSBI.BigInt(10000)),
    JSBI.divide(JSBI.multiply(value.raw, JSBI.BigInt(10000 + slippage)), JSBI.BigInt(10000)),
  ];
}

// account is not optional
export function getSigner(library: Web3Provider, account: string): JsonRpcSigner {
  return library.getSigner(account).connectUnchecked();
}

// account is optional
export function getProviderOrSigner(library: Web3Provider, account?: string): Web3Provider | JsonRpcSigner {
  return account ? getSigner(library, account) : library;
}

// account is optional
export function getContract(address: string, ABI: any, library: Web3Provider, account?: string): Contract {
  if (!isAddress(address) || address === AddressZero) {
    throw Error(`Invalid 'address' parameter '${address}'.`);
  }

  return new Contract(address, ABI, getProviderOrSigner(library, account) as any);
}

// account is optional
export function getRouterContract(_: number, library: Web3Provider, account?: string): Contract {
  return getContract(ROUTER_ADDRESS, IUniswapV2Router02ABI, library, account);
}

export function getPairContract(pairAddress: string, library: Web3Provider, account?: string): Contract {
  return getContract(pairAddress, pairABI, library, account);
}

export function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
}

export function isTokenOnList(defaultTokens: TokenAddressMap, currency?: Currency): boolean {
  if (currency === ETHER) return true;
  return Boolean(currency instanceof Token && defaultTokens[currency.chainId]?.[currency.address]);
}

function getNestedStorageKey(key1: string, key2: string, slotOfMap: string) {
  const firstLevelKey = ethers.utils.solidityKeccak256(['uint', 'uint'], [key1, slotOfMap]);
  return ethers.utils.solidityKeccak256(['uint', 'uint'], [key2, firstLevelKey]);
}

function getArrayItemKey(index: number, slotOfArray: string) {
  let slot: any = ethers.utils.solidityKeccak256(['uint'], [slotOfArray]);
  if (index > 0) {
    const increment = ethers.BigNumber.from(index);
    slot = ethers.BigNumber.from(slot).add(increment);
    slot = slot.toHexString();
  }
  return slot;
}

async function getAllPairsLength(factoryAddress: string, deployer: any) {
  const factoryContract = new ethers.Contract(factoryAddress, factoryABI, deployer);
  let result = await factoryContract.allPairsLength();
  result = ethers.BigNumber.from(result);
  return result.toNumber();
}

function getPair(tokenA: string, tokenB: string, factory: string, codeHash: string) {
  if (!Web3) return;
  console.log('Getting pair for', tokenA, tokenB, factory);
  try {
    const web3 = new Web3(Web3.givenProvider || 'https://liberty20.shardeum.org');
    const [token0, token1] = tokenA < tokenB ? [tokenA, tokenB] : [tokenB, tokenA];

    let abiEncoded1 = web3.eth.abi.encodeParameters(['address', 'address'], [token0, token1]);
    abiEncoded1 = abiEncoded1.split('0'.repeat(24)).join('');
    const salt = web3.utils.soliditySha3(abiEncoded1);
    let abiEncoded2 = web3.eth.abi.encodeParameters(['address', 'bytes32'], [factory, salt]);
    abiEncoded2 = abiEncoded2.split('0'.repeat(24)).join('').substr(2);
    if (!codeHash) return;
    let pairAddress;
    // eslint-disable-next-line @typescript-eslint/ban-ts-ignore
    // @ts-ignore
    if (Web3) pairAddress = Web3.utils.soliditySha3('0xff' + abiEncoded2, codeHash).substr(26);
    if (pairAddress) return '0x' + pairAddress;
    else return null;
  } catch(e) {
    console.error('Error while getting pair address', e)
    return null
  }
}

async function getContractCodeHash(contractAddress: string) {
  if (codeHashMap.has(contractAddress)) {
    return codeHashMap.get(contractAddress);
  } else {
    // const contractAccount: any = await getAccount(contractAddress);
    // if (!contractAccount) {
    //   return Buffer.from([]);
    // }
    // codeHashMap.set(contractAddress, contractAccount.codeHash);
    // return contractAccount.codeHash;
  }
}

export async function generateAccessList(tradeAddresses: any) {
  const { routerAddress, factoryAddress, address1, address2, from } = tradeAddresses;
  const account = from;
  const pairAddress = getPair(address1, address2, factoryAddress, ammAddresses.codeHash);
  // const pairHash = ethers.utils.keccak256(Buffer.from(PAIR.deployedBytecode.slice(2), 'hex'));
  const zeroAddress = '0x' + '0'.repeat(40);
  const balanceMapSlot = '0x1';

  // const allPairLength = (await getAllPairsLength(factoryAddress, signer)) || 1;
  const allPairLength = 1;

  const senderBalanceKey = ethers.utils.solidityKeccak256(['uint', 'uint'], [account, balanceMapSlot]);
  const pairBalanceKey = ethers.utils.solidityKeccak256(['uint', 'uint'], [zeroAddress, balanceMapSlot]);

  const allowKeyOfSender = ethers.utils.solidityKeccak256(['uint', 'uint'], [account, '0x1']);

  const allowKeyOfSenderForPair = ethers.utils.solidityKeccak256(['uint', 'uint'], [routerAddress, allowKeyOfSender]);

  const token_0_1_key = getNestedStorageKey(address1, address2, '0x2');
  const token_1_0_key = getNestedStorageKey(address2, address1, '0x2');
  const allPairKey = getArrayItemKey(allPairLength, '0x3');

  const accessList = [
    [
      pairAddress,
      [
        '0x0000000000000000000000000000000000000000000000000000000000000000',
        '0x0000000000000000000000000000000000000000000000000000000000000003',
        '0x0000000000000000000000000000000000000000000000000000000000000005',
        '0x0000000000000000000000000000000000000000000000000000000000000006',
        '0x0000000000000000000000000000000000000000000000000000000000000007',
        '0x0000000000000000000000000000000000000000000000000000000000000008',
        '0x0000000000000000000000000000000000000000000000000000000000000009',
        '0x000000000000000000000000000000000000000000000000000000000000000a',
        '0x000000000000000000000000000000000000000000000000000000000000000c',
        senderBalanceKey,
        pairBalanceKey,
        '0xb2b81c15af25defa7f931953dc35a7a411b46f9e890702354a2899d421608c23', // codeHash of pair contract
      ],
    ],
    [
      address1,
      [
        ethers.utils.solidityKeccak256(['uint', 'uint'], [routerAddress, '0x3']),
        ethers.utils.solidityKeccak256(['uint', 'uint'], [pairAddress, '0x3']),
        allowKeyOfSenderForPair,
        ethers.utils.solidityKeccak256(['uint', 'uint'], [account, '0x0']),
        ethers.utils.solidityKeccak256(['uint', 'uint'], [pairAddress, '0x0']),
        codeHashMap.get(address1),
      ],
    ],
    [
      address2,
      [
        ethers.utils.solidityKeccak256(['uint', 'uint'], [routerAddress, '0x3']),
        ethers.utils.solidityKeccak256(['uint', 'uint'], [pairAddress, '0x3']),
        allowKeyOfSenderForPair,
        ethers.utils.solidityKeccak256(['uint', 'uint'], [account, '0x0']),
        ethers.utils.solidityKeccak256(['uint', 'uint'], [pairAddress, '0x0']),
        codeHashMap.get(address2),
      ],
    ],
    [
      factoryAddress,
      [
        '0x0000000000000000000000000000000000000000000000000000000000000003',
        token_0_1_key,
        token_1_0_key,
        allPairKey,
        '0x3ceed391ae304e8dc31737fba00513c69846aba35d763fe6a069afbbbd727ca3', // codeHash of factory contract
      ],
    ],
  ];
  console.log(accessList);
  return accessList;
}
