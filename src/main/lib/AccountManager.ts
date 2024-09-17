import EventSubscriber from '@ulixee/commons/lib/EventSubscriber';
import { TypedEventEmitter } from '@ulixee/commons/lib/eventUtils';
import Logger from '@ulixee/commons/lib/Logger';
import Queue from '@ulixee/commons/lib/Queue';
import Env from '@ulixee/datastore/env';
import IDatastoreHostLookup from '@ulixee/datastore/interfaces/IDatastoreHostLookup';
import ILocalUserProfile from '@ulixee/datastore/interfaces/ILocalUserProfile';
import { IDatabrokerAccount, IWallet } from '@ulixee/datastore/interfaces/IPaymentService';
import DatastoreLookup from '@ulixee/datastore/lib/DatastoreLookup';
import LocalUserProfile from '@ulixee/datastore/lib/LocalUserProfile';
import { IArgonFileMeta } from '@ulixee/desktop-interfaces/apis';
import {
  BalanceSyncResult,
  CryptoScheme,
  Localchain,
  LocalchainOverview,
  MainchainClient,
} from '@argonprotocol/localchain';
import { ArgonFileSchema } from '@ulixee/platform-specification/types/IArgonFile';
import ArgonUtils from '@ulixee/platform-utils/lib/ArgonUtils';
import { gettersToObject } from '@ulixee/platform-utils/lib/objectUtils';
import serdeJson from '@ulixee/platform-utils/lib/serdeJson';
import * as Path from 'path';
import BrokerEscrowSource from '@ulixee/datastore/payments/BrokerEscrowSource';
import { IArgonFile } from './ArgonFile';

const { log } = Logger(module);

export default class AccountManager extends TypedEventEmitter<{
  update: { wallet: IWallet };
}> {
  exited = false;
  events = new EventSubscriber();
  public localchains: Localchain[] = [];
  private localchainAddresses = new Map<Localchain, string>();
  private nextTick: NodeJS.Timeout;
  private mainchainClient: MainchainClient;
  private queue = new Queue('LOCALCHAIN', 1);

  constructor(readonly localUserProfile: LocalUserProfile) {
    super();
    if (Env.defaultDataDir) {
      Localchain.setDefaultDir(Path.join(Env.defaultDataDir, 'ulixee', 'localchain'));
    }
  }

  public async loadMainchainClient(url?: string, timeoutMillis?: number): Promise<void> {
    url ??= Env.mainchainUrl;
    if (url) {
      try {
        this.mainchainClient = await MainchainClient.connect(url, timeoutMillis ?? 10e3);
        for (const localchain of this.localchains) {
          await localchain.attachMainchain(this.mainchainClient);
          await localchain.updateTicker();
        }
      } catch (error) {
        log.error('Could not connect to mainchain', { error });
        throw error;
      }
    }
  }

  public async start(): Promise<void> {
    if (!this.localUserProfile.localchainPaths.length) {
      await this.addAccount();
    }
    this.localchains = await Promise.all(
      this.localUserProfile.localchainPaths.map(path =>
        Localchain.loadWithoutMainchain(path, {
          genesisUtcTime: Env.genesisUtcTime,
          tickDurationMillis: Env.tickDurationMillis,
          ntpPoolUrl: Env.ntpPoolUrl,
          escrowExpirationTicks: Env.escrowExpirationTicks,
        }),
      ),
    );
    void this.loadMainchainClient().then(this.emitWallet.bind(this));
    this.scheduleNextSync();
  }

  public async close(): Promise<void> {
    if (this.exited) return;
    this.exited = true;
  }

  public async addBrokerAccount(
    config: ILocalUserProfile['databrokers'][0],
  ): Promise<IDatabrokerAccount> {
    // check first and throw error if invalid
    const balance = await this.getBrokerBalance(config.host, config.userIdentity);
    const entry = this.localUserProfile.databrokers.find(x => x.host === config.host);
    if (entry) {
      entry.userIdentity = config.userIdentity;
      entry.name = config.name;
    } else {
      this.localUserProfile.databrokers.push(config);
    }
    await this.localUserProfile.save();
    return {
      ...config,
      balance,
    };
  }

  public async getBrokerBalance(host: string, identity: string): Promise<bigint> {
    return await BrokerEscrowSource.getBalance(host, identity);
  }

  public async getBrokerAccounts(): Promise<IDatabrokerAccount[]> {
    const brokers = this.localUserProfile.databrokers.map(x => ({ ...x, balance: 0n }));
    for (const broker of brokers) {
      broker.balance = await this.getBrokerBalance(broker.host, broker.userIdentity).catch(
        () => 0n,
      );
    }
    return brokers;
  }

  public async addAccount(
    config: { path?: string; password?: string; cryptoScheme?: CryptoScheme; suri?: string } = {},
  ): Promise<Localchain> {
    config ??= {};
    let defaultPath = config.path ?? Localchain.getDefaultPath();
    if (!defaultPath.endsWith('.db')) {
      defaultPath = Path.join(defaultPath, 'primary.db');
    }
    log.info('Adding localchain', {
      localchainPath: defaultPath,
    } as any);
    const password = config.password
      ? {
          password: Buffer.from(config.password),
        }
      : undefined;
    const localchain = await Localchain.loadWithoutMainchain(
      defaultPath,
      {
        ...Env,
      },
      password,
    );
    this.localchains.push(localchain);

    if (!this.localUserProfile.localchainPaths.includes(localchain.path)) {
      this.localUserProfile.localchainPaths.push(localchain.path);
      await this.localUserProfile.save();
    }
    if (this.mainchainClient) {
      await localchain.attachMainchain(this.mainchainClient);
      await localchain.updateTicker();
    }
    if (!(await localchain.accounts.list()).length) {
      if (config.suri) {
        await localchain.keystore.importSuri(
          config.suri,
          config.cryptoScheme ?? CryptoScheme.Sr25519,
          {
            password: config.password ? Buffer.from(config.password) : undefined,
          },
        );
      } else {
        await localchain.keystore.bootstrap();
      }
    }
    return localchain;
  }

  public async getAddress(localchain: Localchain): Promise<string> {
    if (!this.localchainAddresses.has(localchain)) {
      this.localchainAddresses.set(localchain, await localchain.address);
    }
    return this.localchainAddresses.get(localchain);
  }

  public async getLocalchain(address: String): Promise<Localchain> {
    if (!address) return null;
    for (const chain of this.localchains) {
      if ((await this.getAddress(chain)) === address) return chain;
    }
  }

  public async getDatastoreHostLookup(): Promise<IDatastoreHostLookup | null> {
    return new DatastoreLookup(this.mainchainClient);
  }

  public async getWallet(): Promise<IWallet> {
    const accounts = await Promise.all(this.localchains.map(x => x.accountOverview()));
    const brokerAccounts = await this.getBrokerAccounts();
    let balance = 0n;
    for (const account of accounts) {
      balance += account.balance + account.mainchainBalance;
    }
    for (const account of brokerAccounts) {
      balance += account.balance;
    }

    const formattedBalance = ArgonUtils.format(balance, 'milligons', 'argons');

    return {
      credits: [],
      brokerAccounts,
      accounts,
      formattedBalance,
    };
  }

  public async transferMainchainToLocal(address: string, amount: bigint): Promise<void> {
    const localchain = await this.getLocalchain(address);
    if (!localchain) throw new Error('No localchain found for address');
    await localchain.mainchainTransfers.sendToLocalchain(amount);
  }

  public async transferLocalToMainchain(address: string, amount: bigint): Promise<void> {
    const localchain = await this.getLocalchain(address);
    if (!localchain) throw new Error('No localchain found for address');
    const change = localchain.beginChange();
    const account = await change.defaultDepositAccount();
    await account.sendToMainchain(amount);
    const result = await change.notarize();
    log.info('Localchain to mainchain transfer notarized', {
      notarizationTracker: await gettersToObject(result),
    } as any);
  }

  public async createAccount(
    name: string,
    suri?: string,
    password?: string,
  ): Promise<LocalchainOverview> {
    const path = Path.join(Localchain.getDefaultDir(), `${name}.db`);
    const localchain = await this.addAccount({ path, suri, password });
    return await localchain.accountOverview();
  }

  public async createArgonsToSendFile(request: {
    milligons: bigint;
    fromAddress?: string;
    toAddress?: string;
  }): Promise<IArgonFileMeta> {
    const localchain = (await this.getLocalchain(request.fromAddress)) ?? this.localchains[0];

    const file = await localchain.transactions.send(
      request.milligons,
      request.toAddress ? [request.toAddress] : null,
    );
    const argonFile = JSON.parse(file);

    const recipient = request.toAddress ? `for ${request.toAddress}` : 'cash';
    return {
      rawJson: file,
      file: ArgonFileSchema.parse(argonFile),
      name: `${ArgonUtils.format(request.milligons, 'milligons', 'argons')} ${recipient}.arg`,
    };
  }

  public async createArgonsToRequestFile(request: {
    milligons: bigint;
    sendToMyAddress?: String;
  }): Promise<IArgonFileMeta> {
    const localchain = (await this.getLocalchain(request.sendToMyAddress)) ?? this.localchains[0];
    const file = await localchain.transactions.request(request.milligons);
    const argonFile = JSON.parse(file);

    return {
      rawJson: file,
      file: ArgonFileSchema.parse(argonFile),
      name: `Argon Request ${new Date().toLocaleString()}`,
    };
  }

  public async acceptArgonRequest(
    argonFile: IArgonFile,
    fulfillFromAccount?: String,
  ): Promise<void> {
    if (!argonFile.request) {
      throw new Error('This Argon file is not a request');
    }
    let fromAddress = fulfillFromAccount;
    if (!fromAddress) {
      const funding = argonFile.request.reduce((sum, x) => {
        if (x.accountType === 'deposit') {
          for (const note of x.notes) {
            if (note.noteType.action === 'claim') sum += note.milligons;
          }
        }
        return sum;
      }, 0n);
      for (const account of this.localchains) {
        const overview = await account.accountOverview();
        if (overview.balance >= funding) {
          fromAddress = overview.address;
          break;
        }
      }
    }
    const localchain = (await this.getLocalchain(fromAddress)) ?? this.localchains[0];
    const argonFileJson = serdeJson(argonFile);
    await this.queue.run(async () => {
      const importChange = localchain.beginChange();
      await importChange.acceptArgonFileRequest(argonFileJson);
      const result = await importChange.notarize();
      log.info('Argon request notarized', {
        notarizationTracker: await gettersToObject(result),
      } as any);
    });
  }

  public async importArgons(argonFile: IArgonFile): Promise<void> {
    if (!argonFile.send) {
      throw new Error('This Argon file does not contain any sent argons');
    }

    const filters = argonFile.send
      .map(x => {
        if (x.accountType === 'deposit') {
          for (const note of x.notes) {
            if (note.noteType.action === 'send') {
              return note.noteType.to;
            }
          }
        }
        return [];
      })
      .flat()
      .filter(Boolean);

    let localchain = this.localchains[0];
    for (const filter of filters) {
      const lookup = await this.getLocalchain(filter);
      if (lookup) {
        localchain = lookup;
        break;
      }
    }

    const argonFileJson = serdeJson(argonFile);
    await this.queue.run(async () => {
      const importChange = localchain.beginChange();
      await importChange.importArgonFile(argonFileJson);
      const result = await importChange.notarize();
      log.info('Argon import notarized', {
        notarizationTracker: await gettersToObject(result),
      } as any);
    });
  }

  private scheduleNextSync(): void {
    const localchain = this.localchains[0];
    if (!localchain) return null;
    const nextTick = Number(localchain.ticker.millisToNextTick());
    this.nextTick = setTimeout(() => this.sync().catch(() => null), nextTick + 1);
  }

  private async sync(): Promise<void> {
    clearTimeout(this.nextTick);
    try {
      const syncs = [];
      for (const localchain of this.localchains) {
        syncs.push(await this.queue.run(async () => localchain.balanceSync.sync()));
      }
      const result = syncs.reduce(
        (x, next) => {
          x.escrowNotarizations.push(...next.escrowNotarizations);
          x.balanceChanges.push(...next.balanceChanges);
          x.jumpAccountConsolidations.push(...next.jumpAccountConsolidations);
          x.mainchainTransfers.push(...next.mainchainTransfers);
          return x;
        },
        {
          escrowNotarizations: [],
          balanceChanges: [],
          jumpAccountConsolidations: [],
          mainchainTransfers: [],
        } as BalanceSyncResult,
      );
      if (result.mainchainTransfers.length || result.balanceChanges.length) {
        log.info('Account sync result', {
          ...(await gettersToObject(result)),
        } as any);
        await this.emitWallet();
      }
    } catch (error) {
      log.error('Error synching account balance changes', { error });
    }
    this.scheduleNextSync();
  }

  private async emitWallet(): Promise<void> {
    const wallet = await this.getWallet();
    this.emit('update', { wallet });
  }
}
