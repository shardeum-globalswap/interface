import { BigNumber } from '@ethersproject/bignumber';
import { Contract } from '@ethersproject/contracts';
import { JSBI, Percent, Router, SwapParameters, Trade, TradeType } from '@uniswap/sdk';
import { useMemo } from 'react';
import { BIPS_BASE, INITIAL_ALLOWED_SLIPPAGE, FACTORY_ADDRESS, ROUTER_ADDRESS } from '../constants';
import { useTransactionAdder } from '../state/transactions/hooks';
import { calculateGasMargin, getRouterContract, isAddress, shortenAddress, generateAccessList } from '../utils';
import isZero from '../utils/isZero';
import { useActiveWeb3React } from './index';
import useTransactionDeadline from './useTransactionDeadline';
import useENS from './useENS';
import { ethers } from 'ethers';

export enum SwapCallbackState {
  INVALID,
  LOADING,
  VALID,
}

interface SwapCall {
  contract: Contract;
  parameters: SwapParameters;
}

interface SuccessfulCall {
  call: SwapCall;
  gasEstimate: BigNumber;
}

interface FailedCall {
  call: SwapCall;
  error: Error;
}

type EstimatedSwapCall = SuccessfulCall | FailedCall;

/**
 * Returns the swap calls that can be used to make the trade
 * @param trade trade to execute
 * @param allowedSlippage user allowed slippage
 * @param recipientAddressOrName
 */
function useSwapCallArguments(
  trade: Trade | undefined, // trade to execute, required
  allowedSlippage: number = INITIAL_ALLOWED_SLIPPAGE, // in bips
  recipientAddressOrName: string | null // the ENS name or address of the recipient of the trade, or null if swap should be returned to sender
): SwapCall[] {
  const { account, chainId, library } = useActiveWeb3React();

  const { address: recipientAddress } = useENS(recipientAddressOrName);
  const recipient = recipientAddressOrName === null ? account : recipientAddress;
  const deadline = useTransactionDeadline();
  if (deadline) console.log('DEADLINE', new Date(deadline?.toNumber()), new Date());

  return useMemo(() => {
    if (!trade || !recipient || !library || !account || !chainId || !deadline) return [];

    const contract: Contract | null = getRouterContract(chainId, library, account);
    if (!contract) {
      return [];
    }

    const swapMethods = [];

    swapMethods.push(
      Router.swapCallParameters(trade, {
        feeOnTransfer: false,
        allowedSlippage: new Percent(JSBI.BigInt(allowedSlippage), BIPS_BASE),
        recipient,
        deadline: deadline.toNumber(),
      })
    );

    if (trade.tradeType === TradeType.EXACT_INPUT) {
      swapMethods.push(
        Router.swapCallParameters(trade, {
          feeOnTransfer: true,
          allowedSlippage: new Percent(JSBI.BigInt(allowedSlippage), BIPS_BASE),
          recipient,
          deadline: deadline.toNumber(),
        })
      );
    }

    return swapMethods.map((parameters) => ({ parameters, contract }));
  }, [account, allowedSlippage, chainId, deadline, library, recipient, trade]);
}

// returns a function that will execute a swap, if the parameters are all valid
// and the user has approved the slippage adjusted input amount for the trade
export function useSwapCallback(
  trade: Trade | undefined, // trade to execute, required
  allowedSlippage: number = INITIAL_ALLOWED_SLIPPAGE, // in bips
  recipientAddressOrName: string | null // the ENS name or address of the recipient of the trade, or null if swap should be returned to sender
): { state: SwapCallbackState; callback: null | (() => Promise<string>); error: string | null } {
  const { account, chainId, library } = useActiveWeb3React();

  const swapCalls = useSwapCallArguments(trade, allowedSlippage, recipientAddressOrName);

  const addTransaction = useTransactionAdder();

  const { address: recipientAddress } = useENS(recipientAddressOrName);
  const recipient = recipientAddressOrName === null ? account : recipientAddress;

  return useMemo(() => {
    if (!trade || !library || !account || !chainId) {
      return { state: SwapCallbackState.INVALID, callback: null, error: 'Missing dependencies' };
    }
    if (!recipient) {
      if (recipientAddressOrName !== null) {
        return { state: SwapCallbackState.INVALID, callback: null, error: 'Invalid recipient' };
      } else {
        return { state: SwapCallbackState.LOADING, callback: null, error: null };
      }
    }

    return {
      state: SwapCallbackState.VALID,
      callback: async function onSwap(): Promise<string> {
        const estimatedCalls: EstimatedSwapCall[] = await Promise.all(
          swapCalls.map((call) => {
            const {
              parameters: { methodName, args, value },
              contract,
            } = call;
            const options = !value || isZero(value) ? {} : { value };

            return contract.estimateGas[methodName](...args, options)
              .then((gasEstimate) => {
                return {
                  call,
                  gasEstimate,
                };
              })
              .catch((gasError) => {
                console.debug('Gas estimate failed, trying eth_call to extract error', call);

                return contract.callStatic[methodName](...args, options)
                  .then((result) => {
                    console.debug('Unexpected successful call after failed estimate gas', call, gasError, result);
                    return { call, error: new Error('Unexpected issue with estimating the gas. Please try again.') };
                  })
                  .catch((callError) => {
                    console.debug('Call threw error', call, callError);
                    let errorMessage: string;
                    switch (callError.reason) {
                      case 'SwapRouterV2: INSUFFICIENT_OUTPUT_AMOUNT':
                      case 'SwapRouterV2: EXCESSIVE_INPUT_AMOUNT':
                        errorMessage =
                          'This transaction will not succeed either due to price movement or fee on transfer. Try increasing your slippage tolerance.';
                        break;
                      default:
                        errorMessage = `The transaction cannot succeed due to error: ${callError.reason}. This is probably an issue with one of the tokens you are swapping.`;
                    }
                    return { call, error: new Error(errorMessage) };
                  });
              });
          })
        );

        // a successful estimation is a bignumber gas estimate and the next call is also a bignumber gas estimate
        const successfulEstimation = estimatedCalls.find(
          (el, ix, list): el is SuccessfulCall =>
            'gasEstimate' in el && (ix === list.length - 1 || 'gasEstimate' in list[ix + 1])
        );

        if (!successfulEstimation) {
          const errorCalls = estimatedCalls.filter((call): call is FailedCall => 'error' in call);
          if (errorCalls.length > 0) throw errorCalls[errorCalls.length - 1].error;
          throw new Error('Unexpected error. Please contact support: none of the calls threw an error');
        }

        const {
          call: {
            contract,
            parameters: { methodName, args, value },
          },
          gasEstimate,
        } = successfulEstimation;

        // let txPromise =

        return contract.populateTransaction[methodName](...args, {
          gasLimit: calculateGasMargin(gasEstimate),
          ...(value && !isZero(value) ? { value, from: account } : { from: account }),
        })
          .then(async (response: any) => {
            console.log('Unsigned swap tx', response, JSON.stringify(response));

            const testMode = true;

            if (testMode) {
              try {
                const ethereum: any = window.ethereum;
                console.log('Found ethereum', ethereum);
                console.log('arguments', args, JSON.stringify(args));
                if (!ethereum) return;

                const provider = new ethers.providers.Web3Provider(ethereum);
                // let signer = provider.getSigner()
                const address1 = args[1][0];
                const address2 = args[1][1];
                const ammAddresses = {
                  factoryAddress: FACTORY_ADDRESS,
                  routerAddress: ROUTER_ADDRESS,
                  address1,
                  address2,
                  from: response.from,
                };
                console.log('ammAddresses', ammAddresses);
                const accessList = await generateAccessList(ammAddresses);
                console.log('access list', accessList);

                const originalValue = response.value.toString();
                console.log('ORIGINAL VALUE', typeof originalValue, originalValue);

                const nonce = await ethereum.request({ method: 'eth_getTransactionCount', params: [response.from] });

                const transaction = {
                  ...response,
                  value: ethers.BigNumber.from(originalValue),
                  chainId: 8080,
                  gasPrice: ethers.utils.parseEther('0.000000011'),
                  gasLimit: 300000,
                  nonce: parseInt(nonce, 16),
                  type: 1,
                  accessList,
                };
                delete transaction.from;
                console.log('transaction', transaction, JSON.stringify(transaction));
                const serialized = ethers.utils.serializeTransaction(transaction);
                const message = ethers.utils.keccak256(serialized);
                console.log('message', message);

                // const message = '0x617cbfe610e8a14957b27c4b449624f78b6ebb44b8feb6b4020185afb1ecc2aa'
                const accounts = await ethereum.request({ method: 'eth_requestAccounts' });
                const account = accounts[0];
                console.log('account', account);

                let signature = await ethereum.request({
                  method: 'eth_sign',
                  params: [ethereum.selectedAddress, message],
                });
                console.log('SIGNATURE', signature);

                signature = signature.substring(2);
                const r = '0x' + signature.substring(0, 64);
                const s = '0x' + signature.substring(64, 128);
                const v = parseInt(signature.substring(128, 130), 16);

                const sigObj = { r, s, v };

                console.log(r);
                console.log(s);
                console.log(v);

                const serializedSignedTx = await ethers.utils.serializeTransaction(transaction, sigObj);
                console.log('serializedSignedTx', serializedSignedTx);

                const { hash } = await provider.sendTransaction(serializedSignedTx);
                console.log('tx hash', hash);
                response.hash = hash;
              } catch (e) {
                console.log('TEST MODE ERROR', e);
              }
            }

            // const inputSymbol = trade.inputAmount.currency.symbol;
            // const outputSymbol = trade.outputAmount.currency.symbol;
            // const inputAmount = trade.inputAmount.toSignificant(3);
            // const outputAmount = trade.outputAmount.toSignificant(3);
            //
            // const base = `Swap ${inputAmount} ${inputSymbol} for ${outputAmount} ${outputSymbol}`;
            // const withRecipient =
            //   recipient === account
            //     ? base
            //     : `${base} to ${
            //         recipientAddressOrName && isAddress(recipientAddressOrName)
            //           ? shortenAddress(recipientAddressOrName)
            //           : recipientAddressOrName
            //       }`;
            //
            // addTransaction(response, {
            //   summary: withRecipient,
            // });
            // response.hash = '0x0334bcf3ee47ad9545a5fdc194710e9466a9ba311b6c4f554e20885dedd015f8';

            return response.hash;
          })
          .catch((error: any) => {
            // if the user rejected the tx, pass this along
            if (error?.code === 4001) {
              throw new Error('Transaction rejected.');
            } else {
              // otherwise, the error was unexpected and we need to convey that
              console.error(`Swap failed`, error, methodName, args, value);
              throw new Error(`Swap failed: ${error.message}`);
            }
          });
      },
      error: null,
    };
  }, [trade, library, account, chainId, recipient, recipientAddressOrName, swapCalls, addTransaction]);
}
