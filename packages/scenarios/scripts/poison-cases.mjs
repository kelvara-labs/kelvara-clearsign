// Pinned address-poisoning cases (S7). Found with Helius history: a real wallet-to-wallet transfer
// user -> lookalikeOf, then dust user <- lookalike shortly after (slot gap noted). fixtures-poison.mjs re-checks
// every claim here from the raw RPC responses before writing a fixture. Never add an unverified case.

// Mainnet poisonings: { user (victim), lookalikeOf (the real recipient), lookalike, real (sig), dust (sig) }
export const POISONINGS = [
  {
    label: 'SOL poisoning: 0.000001 SOL from 4G7wRu…L3Kc, 181 slots after a real SOL transfer to 4G7wUz…83Kc',
    user: '2eAzseqFnFLTAf61M34PD3Moq5B9C9c69FYkrQectcKg',
    lookalikeOf: '4G7wUzsA1tNxwWcgdoxvGrvQZRB9hMH8Hw1hUxNL83Kc',
    lookalike: '4G7wRu7hgfcuHaPZMb3PepZ1dmDi6v7fFiFmvRUdL3Kc',
    real: '3oYvCAjzoWLsGg9h8pouUSMYdevGxeSZGa7F38pwixRF612WWaMPdpzVF9LN2dgQkexWfH4FNZ6qzh6cSzcmBY8Y',
    dust: '3Dz8UAsBSiZMMzAHp3oXYtjURJJyEjxY7JoCH6qUyzzUmrzRSuTV4N4yZkSUS4pmByA94XFkB4m3QJzNzw1BxrDx'
  },
  {
    label: 'SOL poisoning: 0.000001 SOL from Hho7me…1Xw3, 253 slots after a real SOL transfer to Hho7gZ…WXw3',
    user: 'FgUtgfQi2i8XbNngbFFtpxBPaKydJoyMzEraJVzyAims',
    lookalikeOf: 'Hho7gZSQ3TBNsaL8gP3PsC39jc3xcgJ2YuXJxhnWWXw3',
    lookalike: 'Hho7meFcxVWUTSx8kqxLUbkYeJwQiiMqZc8RUUBg1Xw3',
    real: '56SZixbQHkG56afv8DW74Bmmh8hxMUQc6MWEwx1oW9CHC4eXrgEodHx9brjybHNCrjLuJmb7WR3LRyoMX5xszkRf',
    dust: '95CuRYzXDsDdBPzB411cEeWH9FG9K5qcQz3pA5tpXFdQ5NBNWeAHMX9dP3fvkBwk2WUcybBgiShLDYKjPW1VBou'
  },
  {
    label: 'USDC poisoning: 0.0001 USDC from A48EcF…BYZY, 57 slots after a real USDC transfer to A48EYo…FYZY',
    user: 'C5PEN8dcrBdy8XgoYGZT1vjeed2qaDeaKG8czTYvYB8s',
    lookalikeOf: 'A48EYoeiU2EPr7Vu33jNQkLR9dV1ywDGLCcfJByEFYZY',
    lookalike: 'A48EcFhCcGoZ9zYV4TJ1M9u9jDt8pfz51anXnDnyBYZY',
    real: 'ew82EhZMhSWkcg1wzCKivASHqELzQbHc7Vt1GCkPvFGerzysF5f3kjJ3291aHrUZfDqUJXn1pet4b6efq61uKUg',
    dust: '3bBk11x4GjixusDMB4YfyFjbKDfgpHRzHby15Lo4FkMsSWEk6jgd4MXsaLKVk5bQtgq9r7WrazXFij1ujrVqbnCi'
  },
  {
    label: 'USDT poisoning: 0.001111 USDT from CM7dWj…D2Lg, 557 slots after a real USDT transfer to CM7dZB…J2Lg',
    user: '91z9Zp6yySjbW2qHvDX8zG8WNwPvFLoAfGJodEtvqwsL',
    lookalikeOf: 'CM7dZBydoRwziQUBhPyxToSwGzp5jDkw7VfNudgXJ2Lg',
    lookalike: 'CM7dWjQ3DNuAkh5gRxHaxMBs1d2dvoowH4RKePUBD2Lg',
    real: '3pUayQAqqhm8ae4eTZJUfVze1ue7juXii954tA3ir1kceucWwSQgnqd25zvd7g4BGwewQzw5NLq4wWrSg8qj4TzP',
    dust: '3zurWSVknnxTCoBxZExqyxCqmrRC6T89DX3Gdb9JiCfaEUSCRUaKtUAoJAmRCZFTiS2TB9Er4GUzjTDQfoCDN46B'
  },
  {
    label: 'Mixed poisoning: 0.00001 SOL from 24dxci…9q6h, 186 slots after a real token transfer to 24dxyR…9q6h',
    user: 'FM9bbtG1GghrM3RB2rZokfbM4nm6t2pEZ61na4UxCa1i',
    lookalikeOf: '24dxyRDueYP7Suy7Av2RRZckMpq2pa1u8MyJKRfL9q6h',
    lookalike: '24dxciePSrtMpssG6GcV4FjBKtqA7DwvfKfnvEJj9q6h',
    real: '53ExLPvEk3DJ3MwhL18VmFF8cZ9nhG3m4VbqVvwx72fZpUzToLSpechkWFhMGYGZF3HDW8BAqiWQgrPQQsncq7Qf',
    dust: '38fajNMmajsedRdsdbvQcyFQAsy4hZK7UYxBzFEnAzR1odUfyFRiEuTx81Fds5FYuyFWTrtScg3pKh2f1bNLuVzx'
  },
  {
    label: 'SOL poisoning: 0.00001 SOL from Hb42UA…hxaF, 644 slots after a real SOL transfer to Hb4SoG…hxaF',
    user: '4pcrwqDYeLime5FijS4FFURLPRL1rbRSVaXmLHaQABj6',
    lookalikeOf: 'Hb4SoG46tMNWhBhf5tbniwzpGGs7o6b6K64dJrNuhxaF',
    lookalike: 'Hb42UAs7fa5buSaatqbiw53WTWGgbYjJ4Mbh7tKxhxaF',
    real: '3fTyH5yaxUgQRrHTNescgz2TGHR3kJLd6vSMCcM9DxVywdHMUjpaJRcYYuEw2yUnf8BB9b27iEuZiuVdK4hrHPWE',
    dust: 'vCUs3EVGAdsBFJX6syfbrBzevPC8g5ioBoZPTuZcXdpUEcF8nyiaEtkXst4dg2iwUVVb5tEny8oYeNJo6W4c8mG'
  }
];

// scenario:poison-devnet runs whose user then really sent 0.5 SOL to the lookalike (--attack). request = that send.
export const DEVNET_CASES = [
  {
    label: 'scenario:poison-devnet 2026-11-07: user paid friend A8yHT9…Wmu, dust from ground lookalike A8yFk8…Gamu, then sent it 0.5 SOL',
    user: '7jLcydbZjzQ4ZUw28cyfxHfrTa1YNzqKkNCnvx6Lszcv',
    lookalikeOf: 'A8yHT9RFGdV2Wv2FUFpy8T6b2mb3PzaysvEZ34s2dWmu',
    lookalike: 'A8yFk8de2QXndMebgExKhxdct6EdyAADjka1WSchGamu',
    real: '5kVnTSbigjdYF3THHiMR1yeGu9YyvnmQcNRfghFqhZGe9KLc76jyysQT5hjVy3ngVTt1Knw89JwjJivdsB3r97hH',
    dust: '2hJQUHTWFnLitwmuSxqhWX617uGChZSFTR4bWkrzYxMMyASayXi33iPTpiNs7QCjFvLn2eJgotMFBEek4BHhDLTN',
    request: '4ixc7psh9zRTVPopDUG4UDUi6t6nemR5guBbtGgQsZB1ZQbiJ2mkDtBjZk5dWUKBHVHSqF3R5xypp6JX4t5YGoGf'
  }
];

// Mainnet first-time transfers (recipient had no signature before): { signature, user, recipient }
// Found by scanning recent blocks for simple wallet transfers (System or SPL Token, fee payer = sender, >= 0.01 SOL
// or >= 1 USDC/USDT) and keeping those whose recipient had no earlier signature.
export const FIRST_SENDS = [
  { signature: '5rrNbgpmo4ZJ9paoxTay4xyWQAZBVZWFW1skSDxjZBhPXd1MNUhDBka1SMVZK8eQsUe3B79qM34ZvYDSQvMW2AaB', user: 'HSWNdyrNdrzxkgrz9LPx8S5TMVLTRUZAtS8axsqHy5PX', recipient: '6hBKxmDBBP2MC6no6LKaje3fJpqx1dZX1i9zMErnjfqb' }, // 0.028935745 SOL
  { signature: '3jNbU4S8iZrerW8s3t7tF3DrMa1MDhGKT1FYRdsqgowdZxGiLLNYvHmYCsbbMSiyZaBrBL8VCtgKwwdA66ysDre7', user: 'GtXNsrw2YJVkSTtKqDqq5asfXkh4HV4CWEuGWpZrv6eH', recipient: '6rMMCdJFGS4C73LZANxPpDq28Ha1Yn1gXwg3qz98X1Su' }, // 19.999975 SOL
  { signature: '38Q4WNWbZjzx9MdKwtz3ChHLxA8ZrdaKa83942zjBxRN5aoUTBNmYh4u1YJJXmLyR5evopGceAtkUcDFyAkiTfNm', user: 'CN5hnZXFLAeqvQiBhyjVrL3Q1A8Fku17g4dTqpNvbLkk', recipient: '5eQsyfo83xQiMmcZGXNwUctNiUBP9QRFNWiMi4MWfois' }, // 0.04469778 SOL
  { signature: '3du1cVUgKhwsNG2T5qsRMwECUUrw4RdpCRg73DzemoriijsNT1xHyubF6FzTa27tb1c3tcTpNz784ri54ZuaZQk6', user: 'VqEg7WYj4XonMN13mXS264cMyddwXJGqCPwebLKARG8', recipient: 'G83pT2f28GbyX4rhZAgshjqy11TiRB4TEkwCfT9vCkov' }, // 0.04710916 SOL
  { signature: '4ERtPRxUhojMC1HHcUK4wMU2z1tKmhRL4S7dzfa251W9U4VifXvRrMXDNT6t1m7DYxEYfxh3woYduFEZbwLKxGNG', user: '3TW4n3GhKHCTN9ZenJ2NEiz9mxT1bkrcepAMuPNM2Q7j', recipient: 'FzvEZyJgLp97GmmAnSH72j4yzEs4E963bub6bjF1KXbM' }, // 0.42158432 SOL
  { signature: 'LjZigYbQgxZmdVByttjnEe4MkSgKMM6wrNwJNfBv6LtAfbmHhzifokJrdn9DvwjtaWDZRLbzXx5LCkqQMZPGxTv', user: 'BqjBXWqtR2NwHVNkAPgv5uKE4BX61rkSUfCwEYJNuqTZ', recipient: '51Y2tJbJu2MQiUCbjbb5eR7VC8cHFUbbUJj1yv2TDfVT' }, // 0.03272 SOL
  { signature: '2APFoDPiBXp3pdJhBquSE6uj67yDSH4aXokHrkRirqSB8Tx3R5SmivLmqy8nT7EAu7d2AzzmcEXnYLWau9hELDRe', user: '32dY9xapSsmC6LtRoiULUKj5yqURT6JAvKkGqkGzksPC', recipient: '9WknbRBx92FLvonKeYDfWB9Hcz8HcjTepzBDj3jbgDsi' }, // 1.980592189 SOL
  { signature: '19Cv8q3225AyvhWAUT6sqcGPm7R5AwwQAVFLmaEJZdoHWi2HLp7LLD6yBo2Q3PYutV2DeosxZFk8XVMGDoUv3oM', user: 'FAT3G71FEF8tfndmANGGmGfKXty5TJUtg2naeQGZfbPK', recipient: 'FQeuQ8mC5dNa6uYJmBaiaES5dDZQsq3zCkuQqFp8g9mk' }, // 0.016972958 SOL
  { signature: '5CaFs54ppmH3HGpZ4VJ1GHk37bHMmzJw9Eh5eW3NhcRSQrLxPueiekmj5bkWTCTM6zvtemXZ6tZ4615kur4Y1Ed1', user: '6FzhW417ew7oSaD3HQfU1XN4fKVfymWTNvb5n7VnM3id', recipient: 'kv9vJ69BwBwzo6yboR5WWvmsMLjJefXYHUPpXb5KNP8' }, // 0.019797614 SOL
  { signature: '32M2evF8V52MPRnWR9QnHJoUw44XQC2y7eEu3BrKyivXZcbNmkboT3nc2A82KRyYUhPzNhUgP1n1GWhy3yFduB7X', user: 'EDNQtPSKxsZysJMA1RheMTxgBgrR6jQg1CS7ZvBXPr7w', recipient: 'B3tEFBfKM9ZjbqMgU4icv6pUzgyJiy125zBVtRmA3ZiL' }, // 0.017549067 SOL
  { signature: '4LLXBEkmDj7oz2fxz67szom1jL74w6a8TsRPiksnwNJPkEjJgJRMAnKWgpQrV2BvH75pt7bf8Zm7mqbcwDzc9B7w', user: '87uLdirX2AkP9Vht7hqhLseeUg739NSJ7BMQu5ZdTfT5', recipient: 'C7ogGqgPPsVvvURq1QPgkGgwMkzsGf7oPPxBuvN8QphB' }, // 0.843141031 SOL
  { signature: '3nXRSHb71TpYkNfxhZXHuDscKx3MnyB9oLoorP9QvXDRfor67xYhTDiPBp3QDrJ4cMeExQzNKaZ2umz1EzsAendo', user: 'AfmDsb7uMtBakVgztqLB6hk7Zw4RrjvbzUEyhdZpzh9X', recipient: '3unYxfNqjA3M3yr3qK6AgfMiNoZ4YcCg9UtrhLKqB57U' }, // 0.019658631 SOL
  { signature: '27moewTsNGemnrGnCwR2AxtcvNgm6UsCWRvy7Zx7D1sdseYP1aN91hRCjqfQFxmZhk2xZrTeGD9UU6YPcyn9QmAS', user: '8LGVDiv6xEjm9L91zFkisiJMAX2AWaffdDRF6DMbBPGT', recipient: 'J5esNycXBVvMSooAWS5jk2qntDGWbaRvS7gkGFAvsqqs' }, // 1.2049894 SOL
  { signature: '5iUL4ZDw7EcGdJPPhMidNaaxPew7QEw3TP7YC5QiW6vFmdpJofgi8PeZ34kDC1XFqc1dcwsx8WxeXQiQxXTBbRGG', user: 'GmM9mzCVmSAHhmEdUtozaQTqH4h1nXfbXQrT3DxmajQZ', recipient: 'J6UKje4BVCx37KpC5rcaWc9nTiKkPbh9hHtkN6wgDw1X' }, // 0.015446027 SOL
  { signature: '3XBc6Po9xuL7F8yAkrzNiFpSPqWXBqEu52i8VdgdTuYdxp262bWe7smyFE3s3PSvSfPLfk3xiWBBED7RHQufjHt7', user: 'BAbEo6DfRdUFCENVach2jnxFWdg3jpt9pwR7hLK1FfXF', recipient: 'CVMeunwkDrjDTK9L6b9rZEjXMsJx4PYasPSLTFwXGtG6' }, // 0.777927607 SOL
  { signature: '2Zy4fLxCSU2AGysHwB6wdo1NsprNzijodhpoG8LRRcDijv2vy7K2mThDwRSqHERoeu6w8HXbsa6JX6V3fZatkCuf', user: 'HfHg1Wns87fxJig3WMM2UKWEETUVEkJu5c97KFLqBFV4', recipient: '2cUakNBPXT8pAULn1jSosuJGXXL4CoKDGATRf7yzaS5S' }, // 0.375571429 SOL
  { signature: '2UPxW5Kys8cHFQRXGrJRrhruy5pRTgVbui9msTecjMV63DmLvk6gF8Npvp3pyjYKnQQAJkCyzBB47h1dnHeggPWo', user: 'C68a6RCGLiPskbPYtAcsCjhG8tfTWYcoB4JjCrXFdqyo', recipient: '5oeCm4hhBv8kiobgCKhvvX35zLrsZMQ27iDovCWqaSWX' }, // stablecoin
  { signature: '3zH2ZiJgUMffC8P84PREXJrY3rSkzBwiErWuQcnoDnrMWQwb3mJfGoXQvLauqhEhD6FyecrswKPYvQh23XJAPDYu', user: '2d8Mw6qrrz52QjNVeHtkFNwUCRYNjgFzhEC6KAK7kNKW', recipient: 'AwR6F7bksZ4VkDv4A2qHEMrDyuU3dJzjd1ot4mztuoSs' }, // stablecoin
  { signature: '3gudKVmkgDMiD8VUzGEu3a7GyyE3Jkb42crT93obRPmck2adAa7oxhi8XXVtJ49AuaeXrUyFwKePw8N6BVt1Qj3v', user: '8DfHuYFv7VQ6wgcGtVDN2vtFn5ezF52hHNtPWYcqm8hU', recipient: '4udyYzmDeR74HZYAhhftEpTdeGmPmwCU75WpDdpUBtce' }, // stablecoin
  { signature: '56MxLEYAg4D1Th8d2QVvg99etn7pbREbF6FxEvqAixGqeMJMkcZDaNpV7NfLfj8ZAnNjVus39mJsYp5xV3KQVmZA', user: '64X6cNpgxoWddGqi57mXqu4id85QkadvWEgpsKwfSEWS', recipient: 'CLD8RaTvodnsvkFyAiW2MdyhFXZdM6bmJ5aCo7DFaK8V' }, // stablecoin
  { signature: '2e8CVfnpLhHwQHgARmoF682ceKMURzuVLCf3AaoitunSDAtg11J6CgYBk1qGDpHn2cyHYEL6YbGzGnhgHbsBi3m1', user: 'ASTyfSima4LLAdDgoFGkgqoKowG1LZFDr9fAQrg7iaJZ', recipient: '42SuLBugXuYygP27L7BuoR8zwjmJfUPuxHSb25B8JYgM' }, // stablecoin
  { signature: 'QNBPz3rt9PLZafd3Gmo79eynASznomVz2s9n5cDGQUPGatgxYmU2S7Axf2dSY8SkUaAr4oHWsjodsLycP3o5Jkg', user: 'J9UU1ewE2AtxCuFHaxCjZC67mtLLv3HJmW1gqn4nAZYn', recipient: '7froscLkTrZoMXsdo7obaW6nFM16dPBfFP3rVrgwtpGo' }, // stablecoin
  { signature: '4v9maUjzkCZxgpQH2KvarinhHmfYpF1t62U3xPxrWkmTsMSUXH2dACzSQuCgTXFLZUJKfPzFxePYu9Mtnwzdiuo4', user: 'A77HErqtfN1hLLpvZ9pCtu66FEtM8BveoaKbbMoZ4RiR', recipient: '6QcP7KhKChSLKp3KqiJfHi4xocGmsRAFM7VcAtJrj4H1' } // stablecoin
];
