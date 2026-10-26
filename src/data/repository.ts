import {
  UserSettings,
  PaymentMethod,
  ExpenseRecord,
  RecurringExpenseRecord,
  EarningRecord,
  TransferRecord,
  PersonRecord,
  PeerTransactionRecord,
  IncomeSource,
  AppNotification,
  EcOConnection,
  EcOProposal,
  IssueReport
} from '../domain/types';
import { createDefaultPaymentMethods } from '../domain/paymentMethods';
import { SEVEN_DAYS_MS } from '../domain/dates';
import { EcoBackupV1, migrateBackupV1ToDomain } from '../domain/backupV1';
import {
  invertProposalDirection,
  generateDefaultConnectionCode,
  formatConnectionCode,
  validateConnectionCode
} from '../domain/connections';
import { db, isFirebaseConfigured, handleFirestoreError, OperationType, sanitizeForFirestore } from './firebase';
import {
  doc,
  collection,
  setDoc,
  deleteDoc,
  getDoc,
  getDocs,
  onSnapshot,
  Unsubscribe,
  writeBatch,
  query,
  where
} from 'firebase/firestore';

export class HybridFirebaseRepository {
  private listeners: Set<() => void> = new Set();
  private unsubs: Unsubscribe[] = [];
  private activeUserId: string | null = null;
  private userDisplayName: string = 'EcO User';
  private userEmail: string = '';

  // In-memory user data cache
  private settings: UserSettings | null = null;
  private paymentMethods: PaymentMethod[] = [];
  private expenses: ExpenseRecord[] = [];
  private recurringExpenses: RecurringExpenseRecord[] = [];
  private earnings: EarningRecord[] = [];
  private transfers: TransferRecord[] = [];
  private people: PersonRecord[] = [];
  private transactions: PeerTransactionRecord[] = [];
  private sources: IncomeSource[] = [];
  private notifications: AppNotification[] = [];
  private connections: EcOConnection[] = [];
  private proposals: EcOProposal[] = [];
  private dismissedMilestones: Record<string, string[]> = {};
  private myConnectionCode: string = 'ECO-USER';
  private firstLaunchDone: boolean = false;

  constructor() {
    this.loadFromLocalStorageCache();
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', (e) => {
        if (
          e.key?.startsWith('eco_shared_proposals') ||
          e.key?.startsWith('eco_shared_connections') ||
          e.key?.startsWith('eco_code_registry') ||
          e.key?.includes('proposals') ||
          e.key?.includes('connections')
        ) {
          this.loadFromLocalStorageCache();
          this.notify();
        }
      });
    }
  }

  subscribe(callback: () => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  private notify() {
    this.listeners.forEach((cb) => {
      try {
        cb();
      } catch (e) {
        console.error('Repository listener error:', e);
      }
    });
  }

  private getStorageKey(key: string): string {
    const userPrefix = this.activeUserId ? `eco_user_${this.activeUserId}_` : 'eco_local_';
    return `${userPrefix}${key}`;
  }

  private async setDocSafe(docRef: any, data: any, options?: { merge?: boolean }) {
    const sanitized = sanitizeForFirestore(data);
    return options ? setDoc(docRef, sanitized, options) : setDoc(docRef, sanitized);
  }

  /**
   * Initializes data streams for the logged-in user.
   */
  async initForUser(userId: string, userDisplayName?: string, userEmail?: string): Promise<boolean> {
    // Unsubscribe from previous user streams if any
    this.unsubs.forEach((unsub) => unsub());
    this.unsubs = [];
    this.activeUserId = userId;
    this.userDisplayName = userDisplayName || 'EcO User';
    this.userEmail = userEmail || '';

    // 1. Load from local cache for instant zero-latency render
    this.loadFromLocalStorageCache();

    // Determine or generate unique Connection Code for this user
    let userCode = localStorage.getItem(this.getStorageKey('connectionCode'));
    if (!userCode || userCode === 'ECO-USER') {
      userCode = generateDefaultConnectionCode(userId);
      this.myConnectionCode = userCode;
      localStorage.setItem(this.getStorageKey('connectionCode'), userCode);
    } else {
      this.myConnectionCode = userCode;
    }

    // Save in public code registry for local offline & cross-tab testing
    try {
      localStorage.setItem(
        `eco_code_registry_${this.myConnectionCode}`,
        JSON.stringify({
          code: this.myConnectionCode,
          userId: userId,
          displayName: this.userDisplayName,
          email: this.userEmail,
          updatedAt: Date.now()
        })
      );
    } catch {}

    // 2. If Firebase is active and configured, synchronize Firestore collections
    if (isFirebaseConfigured() && db) {
      try {
        const userRef = doc(db, 'users', userId);
        const userSnap = await getDoc(userRef);

        if (!userSnap.exists()) {
          // Check if there was pre-login guest data in local storage
          const guestMethodsRaw = localStorage.getItem('eco_local_paymentMethods');
          const guestSettingsRaw = localStorage.getItem('eco_local_settings');
          const guestExpensesRaw = localStorage.getItem('eco_local_expenses');
          const guestEarningsRaw = localStorage.getItem('eco_local_earnings');
          const guestTransfersRaw = localStorage.getItem('eco_local_transfers');
          const guestPeopleRaw = localStorage.getItem('eco_local_people');
          const guestTxRaw = localStorage.getItem('eco_local_transactions');
          const guestSetup =
            localStorage.getItem('eco_local_setupComplete') === 'true' ||
            localStorage.getItem('eco_onboarding_completed') === 'true';

          let initialSettings: UserSettings = {
            id: userId,
            theme: 'dark',
            colorPalette: 'green',
            setupComplete: false,
            budgetMode: 'direct',
            directDailyBudget: 500,
            monthlyIncome: 0,
            monthlyFixed: 0,
            monthlySavings: 0,
            monthlyEmergency: 0,
            bufferPct: 10,
            cashoutChargeRate: 2,
            categories: ['Food', 'Transport', 'Groceries', 'Utilities', 'Entertainment', 'Health', 'Shopping', 'Other'],
            tags: ['Personal', 'Work', 'Family', 'Loan', 'Project'],
            currencySymbol: '৳'
          };

          if (guestSettingsRaw) {
            try {
              initialSettings = { ...initialSettings, ...JSON.parse(guestSettingsRaw), id: userId };
            } catch {}
          }
          if (guestSetup) {
            initialSettings.setupComplete = true;
          }

          let initialMethods: PaymentMethod[] = createDefaultPaymentMethods();
          if (guestMethodsRaw) {
            try {
              const parsedM = JSON.parse(guestMethodsRaw);
              if (Array.isArray(parsedM) && parsedM.length > 0) {
                initialMethods = parsedM;
              }
            } catch {}
          } else if (this.paymentMethods.length > 0) {
            initialMethods = [...this.paymentMethods];
          }

          // Compute opening balances mapping
          const cashM = initialMethods.find((m) => m.type === 'cash' || m.name.toLowerCase() === 'cash');
          const bkashM = initialMethods.find((m) => m.name.toLowerCase().includes('bkash'));
          const nagadM = initialMethods.find((m) => m.name.toLowerCase().includes('nagad'));
          const openingBalancesData = {
            cash: cashM?.openingBalance || 0,
            bkash: bkashM?.openingBalance || 0,
            nagad: nagadM?.openingBalance || 0,
            updatedAt: new Date().toISOString()
          };

          await this.setDocSafe(userRef, {
            ...initialSettings,
            uid: userId,
            displayName: this.userDisplayName,
            email: this.userEmail,
            connectionCode: this.myConnectionCode,
            openingBalances: openingBalancesData,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          });

          // Save openingBalances subcollection
          await this.setDocSafe(doc(db, 'users', userId, 'openingBalances', 'current'), {
            id: 'current',
            cash: openingBalancesData.cash,
            bkash: openingBalancesData.bkash,
            nagad: openingBalancesData.nagad,
            date: new Date().toISOString().split('T')[0],
            updatedAt: Date.now()
          });

          // Seed or migrate payment methods
          for (const m of initialMethods) {
            await this.setDocSafe(doc(db, 'users', userId, 'paymentMethods', m.id), m);
          }
          this.paymentMethods = initialMethods;
          this.saveToLocalStorageCache('paymentMethods', initialMethods);

          // Seed default income sources
          const defaultSources: IncomeSource[] = [
            { id: 'src_salary', name: 'Salary', description: 'Primary monthly income', createdAt: new Date().toISOString() },
            { id: 'src_freelance', name: 'Freelance', description: 'Projects and consulting', createdAt: new Date().toISOString() },
            { id: 'src_investment', name: 'Investments', description: 'Dividends and profits', createdAt: new Date().toISOString() }
          ];
          for (const s of defaultSources) {
            await this.setDocSafe(doc(db, 'users', userId, 'sources', s.id), s);
          }
          this.sources = defaultSources;
          this.saveToLocalStorageCache('sources', defaultSources);

          // Migrate any guest expenses, earnings, transfers, people, transactions
          if (guestExpensesRaw) {
            try {
              const exps: ExpenseRecord[] = JSON.parse(guestExpensesRaw);
              for (const e of exps) {
                await this.setDocSafe(doc(db, 'users', userId, 'expenses', e.id), e);
              }
              this.expenses = exps;
              this.saveToLocalStorageCache('expenses', exps);
            } catch {}
          }
          if (guestEarningsRaw) {
            try {
              const earns: EarningRecord[] = JSON.parse(guestEarningsRaw);
              for (const e of earns) {
                await this.setDocSafe(doc(db, 'users', userId, 'earnings', e.id), e);
              }
              this.earnings = earns;
              this.saveToLocalStorageCache('earnings', earns);
            } catch {}
          }
          if (guestTransfersRaw) {
            try {
              const trs: TransferRecord[] = JSON.parse(guestTransfersRaw);
              for (const t of trs) {
                await this.setDocSafe(doc(db, 'users', userId, 'transfers', t.id), t);
              }
              this.transfers = trs;
              this.saveToLocalStorageCache('transfers', trs);
            } catch {}
          }
          if (guestPeopleRaw) {
            try {
              const pps: PersonRecord[] = JSON.parse(guestPeopleRaw);
              for (const p of pps) {
                await this.setDocSafe(doc(db, 'users', userId, 'people', p.id), p);
              }
              this.people = pps;
              this.saveToLocalStorageCache('people', pps);
            } catch {}
          }
          if (guestTxRaw) {
            try {
              const txs: PeerTransactionRecord[] = JSON.parse(guestTxRaw);
              for (const tx of txs) {
                await this.setDocSafe(doc(db, 'users', userId, 'transactions', tx.id), tx);
              }
              this.transactions = txs;
              this.saveToLocalStorageCache('transactions', txs);
            } catch {}
          }

          this.settings = initialSettings;
          this.firstLaunchDone = Boolean(initialSettings.setupComplete);
        } else {
          // Existing user document found in Firestore: load profile & settings
          const data = userSnap.data();
          this.settings = {
            id: userId,
            theme: data.theme || 'dark',
            colorPalette: data.colorPalette || 'green',
            setupComplete: Boolean(data.setupComplete),
            budgetMode: data.budgetMode || 'direct',
            directDailyBudget: data.directDailyBudget ?? 500,
            monthlyIncome: data.monthlyIncome ?? 0,
            monthlyFixed: data.monthlyFixed ?? 0,
            monthlySavings: data.monthlySavings ?? 0,
            monthlyEmergency: data.monthlyEmergency ?? 0,
            bufferPct: data.bufferPct ?? 10,
            cashoutChargeRate: data.cashoutChargeRate ?? 2,
            categories: data.categories || ['Food', 'Transport', 'Utilities'],
            tags: data.tags || ['Personal'],
            currencySymbol: '৳'
          };
          this.firstLaunchDone = Boolean(data.setupComplete);
          this.saveToLocalStorageCache('settings', this.settings);

          if (data?.connectionCode && data.connectionCode !== 'ECO-USER') {
            this.myConnectionCode = data.connectionCode;
            localStorage.setItem(this.getStorageKey('connectionCode'), this.myConnectionCode);
          } else {
            await this.setDocSafe(userRef, { connectionCode: this.myConnectionCode }, { merge: true });
          }

          // AWAIT all subcollections synchronously so mobile has 100% of data before resolving!
          try {
            const [
              methodsSnap,
              expensesSnap,
              recurringSnap,
              earningsSnap,
              transfersSnap,
              peopleSnap,
              transactionsSnap,
              sourcesSnap,
              notifsSnap
            ] = await Promise.all([
              getDocs(collection(db, 'users', userId, 'paymentMethods')),
              getDocs(collection(db, 'users', userId, 'expenses')),
              getDocs(collection(db, 'users', userId, 'recurringExpenses')),
              getDocs(collection(db, 'users', userId, 'earnings')),
              getDocs(collection(db, 'users', userId, 'transfers')),
              getDocs(collection(db, 'users', userId, 'people')),
              getDocs(collection(db, 'users', userId, 'transactions')),
              getDocs(collection(db, 'users', userId, 'sources')),
              getDocs(collection(db, 'users', userId, 'notifications'))
            ]);

            let loadedMethods = methodsSnap.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) as PaymentMethod[];
            if (loadedMethods.length === 0) {
              loadedMethods = createDefaultPaymentMethods();
              for (const m of loadedMethods) {
                await this.setDocSafe(doc(db, 'users', userId, 'paymentMethods', m.id), m);
              }
            } else {
              // Ensure core wallets (Cash, bKash, Nagad) exist
              const coreDefaults = createDefaultPaymentMethods();
              for (const def of coreDefaults) {
                const exists = loadedMethods.find(
                  (m) =>
                    m.id === def.id ||
                    m.name.toLowerCase().trim() === def.name.toLowerCase().trim() ||
                    (def.type === 'cash' && m.type === 'cash')
                );
                if (!exists) {
                  await this.setDocSafe(doc(db, 'users', userId, 'paymentMethods', def.id), def);
                  loadedMethods.push(def);
                }
              }
            }

            // Reconcile openingBalances with paymentMethods if user doc or subcollection had openingBalances
            let ob = data.openingBalances;
            if (!ob) {
              try {
                const obSnap = await getDoc(doc(db, 'users', userId, 'openingBalances', 'current'));
                if (obSnap.exists()) ob = obSnap.data();
              } catch {}
            }
            if (ob) {
              let changed = false;
              loadedMethods = loadedMethods.map((m) => {
                const nameLower = m.name.toLowerCase();
                if ((m.type === 'cash' || nameLower === 'cash') && ob.cash !== undefined && m.openingBalance !== Number(ob.cash)) {
                  changed = true;
                  return { ...m, openingBalance: Number(ob.cash) || 0 };
                }
                if (nameLower.includes('bkash') && ob.bkash !== undefined && m.openingBalance !== Number(ob.bkash)) {
                  changed = true;
                  return { ...m, openingBalance: Number(ob.bkash) || 0 };
                }
                if (nameLower.includes('nagad') && ob.nagad !== undefined && m.openingBalance !== Number(ob.nagad)) {
                  changed = true;
                  return { ...m, openingBalance: Number(ob.nagad) || 0 };
                }
                return m;
              });
              if (changed) {
                for (const m of loadedMethods) {
                  await this.setDocSafe(doc(db, 'users', userId, 'paymentMethods', m.id), m, { merge: true });
                }
              }
            }

            this.paymentMethods = loadedMethods;
            this.expenses = expensesSnap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));
            this.recurringExpenses = recurringSnap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));
            this.earnings = earningsSnap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));
            this.transfers = transfersSnap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));
            this.people = peopleSnap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));
            this.transactions = transactionsSnap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));
            this.sources = sourcesSnap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));
            this.notifications = notifsSnap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));

            // Save to local device cache for offline availability
            this.saveToLocalStorageCache('paymentMethods', this.paymentMethods);
            this.saveToLocalStorageCache('expenses', this.expenses);
            this.saveToLocalStorageCache('recurringExpenses', this.recurringExpenses);
            this.saveToLocalStorageCache('earnings', this.earnings);
            this.saveToLocalStorageCache('transfers', this.transfers);
            this.saveToLocalStorageCache('people', this.people);
            this.saveToLocalStorageCache('transactions', this.transactions);
            this.saveToLocalStorageCache('sources', this.sources);
            this.saveToLocalStorageCache('notifications', this.notifications);
          } catch (syncErr) {
            console.warn('[EcO Firestore] Could not pre-fetch subcollections:', syncErr);
          }
        }

        // Register connectionCode in public lookup collection
        try {
          await this.setDocSafe(doc(db, 'connectionCodes', this.myConnectionCode), {
            code: this.myConnectionCode,
            userId: userId,
            displayName: this.userDisplayName,
            email: this.userEmail,
            updatedAt: Date.now()
          }, { merge: true });
        } catch (codeRegErr) {
          console.warn('[EcO Firestore] Could not register connectionCode in directory:', codeRegErr);
        }

        // Attach real-time subcollection listeners for ongoing updates
        this.attachFirestoreListeners(userId);
      } catch (err) {
        console.warn('[EcO Firestore] Could not sync user root doc, falling back to local storage:', err);
      }
    }

    this.notify();
    return this.firstLaunchDone;
  }

  /**
   * Cleans up all data and unsubscribes when user logs out.
   */
  clearUserData() {
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    this.activeUserId = null;
    this.userDisplayName = 'EcO User';
    this.userEmail = '';
    this.myConnectionCode = 'ECO-USER';
    this.settings = null;
    this.paymentMethods = [];
    this.expenses = [];
    this.recurringExpenses = [];
    this.earnings = [];
    this.transfers = [];
    this.people = [];
    this.transactions = [];
    this.sources = [];
    this.notifications = [];
    this.connections = [];
    this.proposals = [];
    this.dismissedMilestones = {};
    this.firstLaunchDone = false;
    this.notify();
  }

  private attachFirestoreListeners(userId: string) {
    const firestoreDb = db;
    if (!firestoreDb) return;

    // 1. Settings doc
    const userDocRef = doc(firestoreDb, 'users', userId);
    this.unsubs.push(
      onSnapshot(
        userDocRef,
        (snapshot) => {
          if (snapshot.exists()) {
            const data = snapshot.data();
            this.settings = {
              id: userId,
              theme: data.theme || 'dark',
              colorPalette: data.colorPalette || 'green',
              setupComplete: Boolean(data.setupComplete),
              budgetMode: data.budgetMode || 'direct',
              directDailyBudget: data.directDailyBudget ?? 500,
              monthlyIncome: data.monthlyIncome ?? 0,
              monthlyFixed: data.monthlyFixed ?? 0,
              monthlySavings: data.monthlySavings ?? 0,
              monthlyEmergency: data.monthlyEmergency ?? 0,
              bufferPct: data.bufferPct ?? 10,
              cashoutChargeRate: data.cashoutChargeRate ?? 2,
              categories: data.categories || ['Food', 'Transport', 'Utilities'],
              tags: data.tags || ['Personal'],
              currencySymbol: '৳'
            };
            this.firstLaunchDone = Boolean(data.setupComplete);
            this.saveToLocalStorageCache('settings', this.settings);
            this.notify();
          }
        },
        (err) => handleFirestoreError(err, OperationType.GET, `users/${userId}`)
      )
    );

    // 2. Subcollections helper
    const subcollections = [
      { name: 'paymentMethods', target: 'paymentMethods' },
      { name: 'expenses', target: 'expenses' },
      { name: 'recurringExpenses', target: 'recurringExpenses' },
      { name: 'earnings', target: 'earnings' },
      { name: 'transfers', target: 'transfers' },
      { name: 'people', target: 'people' },
      { name: 'transactions', target: 'transactions' },
      { name: 'sources', target: 'sources' },
      { name: 'notifications', target: 'notifications' }
    ] as const;

    subcollections.forEach(({ name, target }) => {
      const colRef = collection(firestoreDb, 'users', userId, name);
      this.unsubs.push(
        onSnapshot(
          colRef,
          (snapshot) => {
            const items = snapshot.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) as any[];
            if (target === 'paymentMethods' && items.length === 0 && this.paymentMethods.length > 0) {
              return; // Avoid transient empty wipe
            }
            (this as any)[target] = items;
            this.saveToLocalStorageCache(target, items);
            this.notify();
          },
          (err) => handleFirestoreError(err, OperationType.LIST, `users/${userId}/${name}`)
        )
      );
    });

    // 3. Shared EcO Connections listener
    try {
      const connQuery = query(
        collection(firestoreDb, 'connections'),
        where('participants', 'array-contains', userId)
      );
      this.unsubs.push(
        onSnapshot(
          connQuery,
          (snapshot) => {
            const items = snapshot.docs.map((d) => d.data()) as EcOConnection[];
            this.connections = items.map((c) => {
              if (c.userAId === userId) {
                return {
                  ...c,
                  peerUserId: c.userBId || c.peerUserId,
                  peerName: c.userBName || c.peerName,
                  peerCode: c.userBCode || c.peerCode
                };
              } else {
                return {
                  ...c,
                  peerUserId: c.userAId || c.peerUserId,
                  peerName: c.userAName || c.peerName,
                  peerCode: c.userACode || c.peerCode
                };
              }
            });
            this.saveToLocalStorageCache('connections', this.connections);
            this.notify();
          },
          (err) => console.warn('[EcO Firestore] Connections sync listener warning:', err)
        )
      );
    } catch (e) {
      console.warn('Failed to attach connections query listener:', e);
    }

    // 4. Shared Proposals listener
    try {
      const propQuery = query(
        collection(firestoreDb, 'proposals'),
        where('participants', 'array-contains', userId)
      );
      this.unsubs.push(
        onSnapshot(
          propQuery,
          async (snapshot) => {
            const items = snapshot.docs.map((d) => d.data()) as EcOProposal[];
            this.proposals = items;
            this.saveToLocalStorageCache('proposals', items);

            // Real-time synchronization:
            // 1. Generate notification for incoming pending proposals
            for (const p of items) {
              if (p.status === 'pending' && p.senderUserId !== userId) {
                const notifExists = this.notifications.some((n) => n.relatedId === p.id);
                if (!notifExists) {
                  const notif: AppNotification = {
                    id: `notif_prop_${p.id}`,
                    type: 'proposal_received',
                    title: `⚡ New EcO ${p.isRepayment ? 'Repayment' : 'Debt'} Request`,
                    body: `${p.senderName} (${p.senderCode || 'peer'}) requested to ${
                      p.originalSenderType === 'give' ? 'lend you' : 'borrow from you'
                    } ৳${p.amount.toLocaleString()}. Tap to accept or reject.`,
                    createdAt: p.createdAt || Date.now(),
                    readAt: null,
                    expiresAt: Date.now() + 7 * 86400000,
                    relatedType: 'proposal',
                    relatedId: p.id
                  };
                  this.addNotification(notif).catch(() => {});
                }
              }

              // 2. When sender's client observes that an outgoing proposal transitioned to 'accepted',
              // if sender doesn't have the confirmed transaction in ledger yet, record it!
              if (p.status === 'accepted' && p.senderUserId === userId) {
                const alreadyRecorded = this.transactions.some(
                  (t) => t.id === `tx_prop_${p.id}_sender` || t.proposalId === p.id
                );
                if (!alreadyRecorded) {
                  let senderPerson = this.people.find(
                    (pe) =>
                      (p.recipientCode && pe.connectionCode === p.recipientCode) ||
                      (p.recipientUserId && pe.connectedUserId === p.recipientUserId) ||
                      pe.name.toLowerCase() === p.recipientName.toLowerCase()
                  );
                  if (!senderPerson) {
                    senderPerson = {
                      id: `person_peer_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`,
                      name: p.recipientName,
                      isConnected: true,
                      connectionCode: p.recipientCode,
                      connectedUserId: p.recipientUserId,
                      createdAt: new Date().toISOString()
                    };
                    await this.addPerson(senderPerson);
                  }
                  const senderTx: PeerTransactionRecord = {
                    id: `tx_prop_${p.id}_sender`,
                    personId: senderPerson.id,
                    type: p.originalSenderType,
                    amount: p.amount,
                    totalAmount: p.amount,
                    payMethodId: p.payMethodId || this.paymentMethods[0]?.id || 'cash',
                    tag: p.isRepayment ? 'Repayment' : 'Shared Debt',
                    description: p.note
                      ? `${p.note} (Confirmed)`
                      : p.isRepayment
                      ? `Repayment confirmed with ${p.recipientName}`
                      : `Shared loan with ${p.recipientName}`,
                    date: p.date,
                    timestamp: p.updatedAt || Date.now(),
                    status: 'accepted',
                    proposalId: p.id
                  };
                  await this.addTransaction(senderTx);
                }
              }
            }

            this.notify();
          },
          (err) => console.warn('[EcO Firestore] Proposals sync listener warning:', err)
        )
      );
    } catch (e) {
      console.warn('Failed to attach proposals query listener:', e);
    }
  }

  private loadFromLocalStorageCache() {
    try {
      const rawSettings = localStorage.getItem(this.getStorageKey('settings'));
      if (rawSettings) {
        this.settings = JSON.parse(rawSettings);
      } else {
        this.settings = {
          id: this.activeUserId || 'main',
          theme: 'dark',
          colorPalette: 'green',
          setupComplete: false,
          budgetMode: 'direct',
          directDailyBudget: 500,
          monthlyIncome: 0,
          monthlyFixed: 0,
          monthlySavings: 0,
          monthlyEmergency: 0,
          bufferPct: 10,
          cashoutChargeRate: 2,
          categories: ['Food', 'Transport', 'Groceries', 'Utilities', 'Entertainment', 'Health', 'Shopping', 'Other'],
          tags: ['Personal', 'Work', 'Family', 'Loan', 'Project'],
          currencySymbol: '৳'
        };
      }

      const rawMethods = localStorage.getItem(this.getStorageKey('paymentMethods'));
      this.paymentMethods = rawMethods ? JSON.parse(rawMethods) : createDefaultPaymentMethods();

      const rawExpenses = localStorage.getItem(this.getStorageKey('expenses'));
      this.expenses = rawExpenses ? JSON.parse(rawExpenses) : [];

      const rawRecurring = localStorage.getItem(this.getStorageKey('recurringExpenses'));
      this.recurringExpenses = rawRecurring ? JSON.parse(rawRecurring) : [];

      const rawEarnings = localStorage.getItem(this.getStorageKey('earnings'));
      this.earnings = rawEarnings ? JSON.parse(rawEarnings) : [];

      const rawTransfers = localStorage.getItem(this.getStorageKey('transfers'));
      this.transfers = rawTransfers ? JSON.parse(rawTransfers) : [];

      const rawPeople = localStorage.getItem(this.getStorageKey('people'));
      this.people = rawPeople ? JSON.parse(rawPeople) : [];

      const rawTransactions = localStorage.getItem(this.getStorageKey('transactions'));
      this.transactions = rawTransactions ? JSON.parse(rawTransactions) : [];

      const rawSources = localStorage.getItem(this.getStorageKey('sources'));
      this.sources = rawSources
        ? JSON.parse(rawSources)
        : [
            { id: 'src_salary', name: 'Salary', description: 'Primary monthly income', createdAt: new Date().toISOString() },
            { id: 'src_freelance', name: 'Freelance', description: 'Projects and consulting', createdAt: new Date().toISOString() },
            { id: 'src_investment', name: 'Investments', description: 'Dividends and profits', createdAt: new Date().toISOString() }
          ];

      const rawNotifications = localStorage.getItem(this.getStorageKey('notifications'));
      this.notifications = rawNotifications ? JSON.parse(rawNotifications) : [];

      const rawConnections = localStorage.getItem(this.getStorageKey('connections'));
      this.connections = rawConnections ? JSON.parse(rawConnections) : [];

      const rawProposals = localStorage.getItem(this.getStorageKey('proposals'));
      this.proposals = rawProposals ? JSON.parse(rawProposals) : [];

      const rawCode = localStorage.getItem(this.getStorageKey('connectionCode'));
      if (rawCode && rawCode !== 'ECO-USER') {
        this.myConnectionCode = rawCode;
      }

      const rawSetup = localStorage.getItem(this.getStorageKey('setupComplete'));
      const globalSetup = localStorage.getItem('eco_onboarding_completed');
      this.firstLaunchDone =
        rawSetup === 'true' ||
        globalSetup === 'true' ||
        this.expenses.length > 0 ||
        this.transactions.length > 0;

      // Cross-tab & multi-tab proposal sync
      try {
        const sharedProps: EcOProposal[] = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.startsWith('eco_shared_proposals_')) {
            try {
              const item = JSON.parse(localStorage.getItem(k) || '');
              if (item && item.id) sharedProps.push(item);
            } catch {}
          }
        }
        if (sharedProps.length > 0) {
          const map = new Map<string, EcOProposal>();
          this.proposals.forEach((p) => map.set(p.id, p));
          sharedProps.forEach((p) => map.set(p.id, p));
          this.proposals = Array.from(map.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        }
      } catch {}
    } catch (e) {
      console.warn('[EcO Cache] Failed to load local cache:', e);
    }
  }

  private saveToLocalStorageCache(key: string, data: any) {
    try {
      localStorage.setItem(this.getStorageKey(key), JSON.stringify(data));
    } catch (e) {
      console.warn('[EcO Cache] Quota exceeded or failed to save to localStorage:', e);
    }
  }

  // --- Getters & Synchronous Accessors ---

  isFirstLaunchDone(): boolean {
    if (this.firstLaunchDone) return true;
    if (this.settings?.setupComplete) return true;
    try {
      if (typeof window !== 'undefined') {
        const localSetup = localStorage.getItem(this.getStorageKey('setupComplete'));
        if (localSetup === 'true' || localSetup === '"true"') return true;
        const globalSetup = localStorage.getItem('eco_onboarding_completed');
        if (globalSetup === 'true') return true;
        if (this.activeUserId) {
          const userDismissed = localStorage.getItem(`eco_onboarding_dismissed_${this.activeUserId}`);
          if (userDismissed === 'true') return true;
        }
      }
    } catch {}
    if (
      this.expenses.length > 0 ||
      this.earnings.length > 0 ||
      this.transfers.length > 0 ||
      this.transactions.length > 0
    ) {
      return true;
    }
    return false;
  }

  async setFirstLaunchDone(val = true): Promise<void> {
    this.firstLaunchDone = val;
    this.saveToLocalStorageCache('setupComplete', val);
    try {
      if (val && typeof window !== 'undefined') {
        localStorage.setItem('eco_onboarding_completed', 'true');
        if (this.activeUserId) {
          localStorage.setItem(`eco_onboarding_dismissed_${this.activeUserId}`, 'true');
        }
      }
    } catch {}
    if (this.settings) {
      this.settings.setupComplete = val;
    }

    if (isFirebaseConfigured() && db && this.activeUserId) {
      try {
        const userRef = doc(db, 'users', this.activeUserId);
        await this.setDocSafe(userRef, { setupComplete: val, updatedAt: new Date().toISOString() }, { merge: true });
      } catch (err) {
        handleFirestoreError(err, OperationType.UPDATE, `users/${this.activeUserId}`);
      }
    }
    this.notify();
  }

  getSettings(): UserSettings {
    if (!this.settings) {
      return {
        id: this.activeUserId || 'main',
        theme: 'dark',
        colorPalette: 'green',
        setupComplete: this.firstLaunchDone,
        budgetMode: 'direct',
        directDailyBudget: 500,
        monthlyIncome: 0,
        monthlyFixed: 0,
        monthlySavings: 0,
        monthlyEmergency: 0,
        bufferPct: 10,
        cashoutChargeRate: 2,
        categories: ['Food', 'Transport', 'Utilities'],
        tags: ['Personal'],
        currencySymbol: '৳'
      };
    }
    return this.settings;
  }

  async saveSettings(settings: UserSettings): Promise<void> {
    this.settings = settings;
    this.saveToLocalStorageCache('settings', settings);

    if (isFirebaseConfigured() && db && this.activeUserId) {
      try {
        const userRef = doc(db, 'users', this.activeUserId);
        await this.setDocSafe(userRef, { ...settings, updatedAt: new Date().toISOString() }, { merge: true });
      } catch (err) {
        handleFirestoreError(err, OperationType.UPDATE, `users/${this.activeUserId}`);
      }
    }
    this.notify();
  }

  // --- Payment Methods ---
  getPaymentMethods(): PaymentMethod[] {
    return this.paymentMethods.length > 0 ? this.paymentMethods : createDefaultPaymentMethods();
  }

  async savePaymentMethod(method: PaymentMethod): Promise<void> {
    const list = [...this.paymentMethods];
    const index = list.findIndex((m) => m.id === method.id);
    const updated = {
      ...method,
      updatedAt: new Date().toISOString()
    };

    if (index >= 0) {
      list[index] = updated;
    } else {
      list.push(updated);
    }
    this.paymentMethods = list;
    this.saveToLocalStorageCache('paymentMethods', list);

    if (isFirebaseConfigured() && db && this.activeUserId) {
      try {
        await this.setDocSafe(doc(db, 'users', this.activeUserId, 'paymentMethods', method.id), updated);

        // Also sync openingBalances to root user document and openingBalances/current subcollection
        const cashM = list.find((m) => m.type === 'cash' || m.name.toLowerCase() === 'cash');
        const bkashM = list.find((m) => m.name.toLowerCase().includes('bkash'));
        const nagadM = list.find((m) => m.name.toLowerCase().includes('nagad'));
        const openingBalancesData = {
          cash: cashM?.openingBalance || 0,
          bkash: bkashM?.openingBalance || 0,
          nagad: nagadM?.openingBalance || 0,
          updatedAt: new Date().toISOString()
        };

        await this.setDocSafe(
          doc(db, 'users', this.activeUserId),
          { openingBalances: openingBalancesData, updatedAt: new Date().toISOString() },
          { merge: true }
        );

        await this.setDocSafe(
          doc(db, 'users', this.activeUserId, 'openingBalances', 'current'),
          {
            id: 'current',
            cash: openingBalancesData.cash,
            bkash: openingBalancesData.bkash,
            nagad: openingBalancesData.nagad,
            date: new Date().toISOString().split('T')[0],
            updatedAt: Date.now()
          },
          { merge: true }
        );
      } catch (err) {
        handleFirestoreError(err, OperationType.WRITE, `users/${this.activeUserId}/paymentMethods/${method.id}`);
      }
    }
    this.notify();
  }

  async archivePaymentMethod(methodId: string): Promise<void> {
    const item = this.paymentMethods.find((m) => m.id === methodId);
    if (item && !item.isBuiltIn) {
      await this.savePaymentMethod({ ...item, isActive: false });
    }
  }

  // --- Expenses ---
  getExpenses(): ExpenseRecord[] {
    return this.expenses;
  }

  async addExpense(expense: ExpenseRecord): Promise<void> {
    this.expenses = [expense, ...this.expenses];
    this.saveToLocalStorageCache('expenses', this.expenses);

    if (isFirebaseConfigured() && db && this.activeUserId) {
      try {
        await this.setDocSafe(doc(db, 'users', this.activeUserId, 'expenses', expense.id), expense);
      } catch (err) {
        handleFirestoreError(err, OperationType.CREATE, `users/${this.activeUserId}/expenses/${expense.id}`);
      }
    }
    this.notify();
  }

  async deleteExpense(expenseId: string): Promise<void> {
    this.expenses = this.expenses.filter((e) => e.id !== expenseId);
    this.saveToLocalStorageCache('expenses', this.expenses);

    if (isFirebaseConfigured() && db && this.activeUserId) {
      try {
        await deleteDoc(doc(db, 'users', this.activeUserId, 'expenses', expenseId));
      } catch (err) {
        handleFirestoreError(err, OperationType.DELETE, `users/${this.activeUserId}/expenses/${expenseId}`);
      }
    }
    this.notify();
  }

  // --- Recurring Expenses ---
  getRecurringExpenses(): RecurringExpenseRecord[] {
    return this.recurringExpenses;
  }

  async addRecurringExpense(rec: RecurringExpenseRecord): Promise<void> {
    this.recurringExpenses = [rec, ...this.recurringExpenses];
    this.saveToLocalStorageCache('recurringExpenses', this.recurringExpenses);

    if (isFirebaseConfigured() && db && this.activeUserId) {
      try {
        await this.setDocSafe(doc(db, 'users', this.activeUserId, 'recurringExpenses', rec.id), rec);
      } catch (err) {
        handleFirestoreError(err, OperationType.CREATE, `users/${this.activeUserId}/recurringExpenses/${rec.id}`);
      }
    }
    this.notify();
  }

  async deleteRecurringExpense(id: string): Promise<void> {
    this.recurringExpenses = this.recurringExpenses.filter((r) => r.id !== id);
    this.saveToLocalStorageCache('recurringExpenses', this.recurringExpenses);

    if (isFirebaseConfigured() && db && this.activeUserId) {
      try {
        await deleteDoc(doc(db, 'users', this.activeUserId, 'recurringExpenses', id));
      } catch (err) {
        handleFirestoreError(err, OperationType.DELETE, `users/${this.activeUserId}/recurringExpenses/${id}`);
      }
    }
    this.notify();
  }

  // --- Earnings ---
  getEarnings(): EarningRecord[] {
    return this.earnings;
  }

  async addEarning(earning: EarningRecord): Promise<void> {
    this.earnings = [earning, ...this.earnings];
    this.saveToLocalStorageCache('earnings', this.earnings);

    if (isFirebaseConfigured() && db && this.activeUserId) {
      try {
        await this.setDocSafe(doc(db, 'users', this.activeUserId, 'earnings', earning.id), earning);
      } catch (err) {
        handleFirestoreError(err, OperationType.CREATE, `users/${this.activeUserId}/earnings/${earning.id}`);
      }
    }
    this.notify();
  }

  async deleteEarning(earningId: string): Promise<void> {
    this.earnings = this.earnings.filter((e) => e.id !== earningId);
    this.saveToLocalStorageCache('earnings', this.earnings);

    if (isFirebaseConfigured() && db && this.activeUserId) {
      try {
        await deleteDoc(doc(db, 'users', this.activeUserId, 'earnings', earningId));
      } catch (err) {
        handleFirestoreError(err, OperationType.DELETE, `users/${this.activeUserId}/earnings/${earningId}`);
      }
    }
    this.notify();
  }

  // --- Transfers ---
  getTransfers(): TransferRecord[] {
    return this.transfers;
  }

  async addTransfer(transfer: TransferRecord): Promise<void> {
    this.transfers = [transfer, ...this.transfers];
    this.saveToLocalStorageCache('transfers', this.transfers);

    if (isFirebaseConfigured() && db && this.activeUserId) {
      try {
        await this.setDocSafe(doc(db, 'users', this.activeUserId, 'transfers', transfer.id), transfer);
      } catch (err) {
        handleFirestoreError(err, OperationType.CREATE, `users/${this.activeUserId}/transfers/${transfer.id}`);
      }
    }
    this.notify();
  }

  async deleteTransfer(transferId: string): Promise<void> {
    this.transfers = this.transfers.filter((t) => t.id !== transferId);
    this.saveToLocalStorageCache('transfers', this.transfers);

    if (isFirebaseConfigured() && db && this.activeUserId) {
      try {
        await deleteDoc(doc(db, 'users', this.activeUserId, 'transfers', transferId));
      } catch (err) {
        handleFirestoreError(err, OperationType.DELETE, `users/${this.activeUserId}/transfers/${transferId}`);
      }
    }
    this.notify();
  }

  // --- People ---
  getPeople(): PersonRecord[] {
    return this.people;
  }

  async addPerson(person: PersonRecord): Promise<void> {
    this.people = [...this.people, person];
    this.saveToLocalStorageCache('people', this.people);

    if (isFirebaseConfigured() && db && this.activeUserId) {
      try {
        await this.setDocSafe(doc(db, 'users', this.activeUserId, 'people', person.id), person);
      } catch (err) {
        handleFirestoreError(err, OperationType.CREATE, `users/${this.activeUserId}/people/${person.id}`);
      }
    }
    this.notify();
  }

  async updatePerson(person: PersonRecord): Promise<void> {
    const list = [...this.people];
    const index = list.findIndex((p) => p.id === person.id);
    if (index >= 0) {
      list[index] = person;
      this.people = list;
      this.saveToLocalStorageCache('people', list);

      if (isFirebaseConfigured() && db && this.activeUserId) {
        try {
          await this.setDocSafe(doc(db, 'users', this.activeUserId, 'people', person.id), person, { merge: true });
        } catch (err) {
          handleFirestoreError(err, OperationType.UPDATE, `users/${this.activeUserId}/people/${person.id}`);
        }
      }
      this.notify();
    }
  }

  async deletePerson(personId: string): Promise<void> {
    this.people = this.people.filter((p) => p.id !== personId);
    this.saveToLocalStorageCache('people', this.people);

    if (isFirebaseConfigured() && db && this.activeUserId) {
      try {
        await deleteDoc(doc(db, 'users', this.activeUserId, 'people', personId));
      } catch (err) {
        handleFirestoreError(err, OperationType.DELETE, `users/${this.activeUserId}/people/${personId}`);
      }
    }
    this.notify();
  }

  // --- Transactions (Lending & Borrowing) ---
  getTransactions(): PeerTransactionRecord[] {
    return this.transactions;
  }

  async addTransaction(tx: PeerTransactionRecord): Promise<void> {
    this.transactions = [tx, ...this.transactions];
    this.saveToLocalStorageCache('transactions', this.transactions);

    if (isFirebaseConfigured() && db && this.activeUserId) {
      try {
        await this.setDocSafe(doc(db, 'users', this.activeUserId, 'transactions', tx.id), tx);
      } catch (err) {
        handleFirestoreError(err, OperationType.CREATE, `users/${this.activeUserId}/transactions/${tx.id}`);
      }
    }
    this.notify();
  }

  async deleteTransaction(txId: string): Promise<void> {
    this.transactions = this.transactions.filter((t) => t.id !== txId);
    this.saveToLocalStorageCache('transactions', this.transactions);

    if (isFirebaseConfigured() && db && this.activeUserId) {
      try {
        await deleteDoc(doc(db, 'users', this.activeUserId, 'transactions', txId));
      } catch (err) {
        handleFirestoreError(err, OperationType.DELETE, `users/${this.activeUserId}/transactions/${txId}`);
      }
    }
    this.notify();
  }

  // --- Sources ---
  getSources(): IncomeSource[] {
    return this.sources;
  }

  async addSource(source: IncomeSource): Promise<void> {
    this.sources = [...this.sources, source];
    this.saveToLocalStorageCache('sources', this.sources);

    if (isFirebaseConfigured() && db && this.activeUserId) {
      try {
        await this.setDocSafe(doc(db, 'users', this.activeUserId, 'sources', source.id), source);
      } catch (err) {
        handleFirestoreError(err, OperationType.CREATE, `users/${this.activeUserId}/sources/${source.id}`);
      }
    }
    this.notify();
  }

  // --- Notifications ---
  getNotifications(): AppNotification[] {
    const now = Date.now();
    return this.notifications
      .filter((n) => !n.expiresAt || n.expiresAt > now)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async addNotification(notification: AppNotification): Promise<void> {
    this.notifications = [notification, ...this.notifications];
    this.saveToLocalStorageCache('notifications', this.notifications);

    if (isFirebaseConfigured() && db && this.activeUserId) {
      try {
        await this.setDocSafe(doc(db, 'users', this.activeUserId, 'notifications', notification.id), notification);
      } catch (err) {
        handleFirestoreError(err, OperationType.CREATE, `users/${this.activeUserId}/notifications/${notification.id}`);
      }
    }
    this.notify();
  }

  async markNotificationRead(id: string): Promise<void> {
    const now = Date.now();
    const list = this.notifications.map((n) =>
      n.id === id ? { ...n, read: true, readAt: n.readAt || now } : n
    );
    this.notifications = list;
    this.saveToLocalStorageCache('notifications', list);

    if (isFirebaseConfigured() && db && this.activeUserId) {
      try {
        await this.setDocSafe(
          doc(db, 'users', this.activeUserId, 'notifications', id),
          { read: true, readAt: now },
          { merge: true }
        );
      } catch (err) {
        handleFirestoreError(err, OperationType.UPDATE, `users/${this.activeUserId}/notifications/${id}`);
      }
    }
    this.notify();
  }

  async markAllNotificationsRead(): Promise<void> {
    const now = Date.now();
    const list = this.notifications.map((n) => ({
      ...n,
      read: true,
      readAt: n.readAt || now
    }));
    this.notifications = list;
    this.saveToLocalStorageCache('notifications', list);

    if (isFirebaseConfigured() && db && this.activeUserId) {
      try {
        const batch = writeBatch(db);
        this.notifications.forEach((n) => {
          batch.update(doc(db!, 'users', this.activeUserId!, 'notifications', n.id), {
            read: true,
            readAt: now
          });
        });
        await batch.commit();
      } catch (err) {
        console.warn('Batch mark read warning:', err);
      }
    }
    this.notify();
  }

  // --- Connections & Milestones ---
  getConnections(): EcOConnection[] {
    return this.connections;
  }

  getProposals(): EcOProposal[] {
    return this.proposals;
  }

  getDismissedMilestones(): Record<string, string[]> {
    return this.dismissedMilestones;
  }

  dismissMilestone(personId: string, milestoneKey: string) {
    const curr = this.dismissedMilestones[personId] || [];
    if (!curr.includes(milestoneKey)) {
      this.dismissedMilestones = {
        ...this.dismissedMilestones,
        [personId]: [...curr, milestoneKey]
      };
      this.saveToLocalStorageCache('dismissedMilestones', this.dismissedMilestones);
      this.notify();
    }
  }

  getMyConnectionCode(): string {
    return this.myConnectionCode;
  }

  async lookupConnectionCode(rawCode: string): Promise<{ code: string; userId: string; displayName?: string; email?: string } | null> {
    const code = formatConnectionCode(rawCode);
    if (!code) return null;

    if (isFirebaseConfigured() && db) {
      try {
        const snap = await getDoc(doc(db, 'connectionCodes', code));
        if (snap.exists()) {
          return snap.data() as any;
        }
      } catch (err) {
        console.warn('Firestore code lookup warning:', err);
      }
    }

    try {
      const raw = localStorage.getItem(`eco_code_registry_${code}`);
      if (raw) return JSON.parse(raw);
    } catch {}

    return null;
  }

  async requestConnection(
    rawCode: string,
    customPeerName?: string
  ): Promise<{ success: boolean; connection?: EcOConnection; error?: string }> {
    const code = formatConnectionCode(rawCode);
    if (!validateConnectionCode(code)) {
      return { success: false, error: 'Invalid connection code format. Format: ECO-XXXXXX' };
    }
    if (code === this.myConnectionCode) {
      return { success: false, error: 'You cannot connect to your own EcO Connection Code.' };
    }

    const existing = this.connections.find((c) => c.peerCode === code);
    if (existing) {
      return { success: false, error: `You are already connected with ${existing.peerName} (${code}).` };
    }

    const found = await this.lookupConnectionCode(code);
    const peerUserId = found?.userId || `user_${code.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
    const peerName = customPeerName?.trim() || found?.displayName || `EcO Friend (${code})`;

    const connId = `conn_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const newConn: EcOConnection = {
      id: connId,
      participants: [this.activeUserId || 'local_user', peerUserId],
      userAId: this.activeUserId || 'local_user',
      userAName: this.userDisplayName,
      userACode: this.myConnectionCode,
      userBId: peerUserId,
      userBName: peerName,
      userBCode: code,
      peerUserId: peerUserId,
      peerName: peerName,
      peerCode: code,
      status: 'connected',
      initiatedBy: this.activeUserId || 'local_user',
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    await this.saveConnection(newConn);

    // Automatically ensure PersonRecord exists in local People ledger
    let person = this.people.find(
      (p) =>
        (code && p.connectionCode === code) ||
        (peerUserId && p.connectedUserId === peerUserId) ||
        p.name.toLowerCase() === peerName.toLowerCase()
    );
    if (!person) {
      person = {
        id: `person_conn_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`,
        name: peerName,
        isConnected: true,
        connectionCode: code,
        connectedUserId: peerUserId,
        createdAt: new Date().toISOString()
      };
      await this.addPerson(person);
    } else if (!person.isConnected || person.connectionCode !== code) {
      await this.updatePerson({
        ...person,
        isConnected: true,
        connectionCode: code,
        connectedUserId: peerUserId
      });
    }

    return { success: true, connection: newConn };
  }

  async saveConnection(conn: EcOConnection): Promise<void> {
    this.connections = [...this.connections.filter((c) => c.id !== conn.id), conn];
    this.saveToLocalStorageCache('connections', this.connections);

    try {
      localStorage.setItem(`eco_shared_connections_${conn.id}`, JSON.stringify(conn));
    } catch {}

    if (isFirebaseConfigured() && db) {
      try {
        await this.setDocSafe(doc(db, 'connections', conn.id), conn);
      } catch (err) {
        console.warn('Firestore connection write error:', err);
      }
    }
    this.notify();
  }

  async deleteConnection(connId: string): Promise<void> {
    const conn = this.connections.find((c) => c.id === connId);
    this.connections = this.connections.filter((c) => c.id !== connId);
    this.saveToLocalStorageCache('connections', this.connections);

    if (conn) {
      try {
        localStorage.removeItem(`eco_shared_connections_${connId}`);
      } catch {}
      const person = this.people.find((p) => p.connectionCode === conn.peerCode);
      if (person) {
        await this.updatePerson({ ...person, isConnected: false });
      }
    }

    if (isFirebaseConfigured() && db) {
      try {
        await deleteDoc(doc(db, 'connections', connId));
      } catch (err) {
        console.warn('Firestore connection delete error:', err);
      }
    }
    this.notify();
  }

  async createProposal(params: {
    recipientCode: string;
    recipientName: string;
    type: 'give' | 'take';
    amount: number;
    date: string;
    note?: string;
    payMethodId?: string;
    isRepayment?: boolean;
  }): Promise<{ success: boolean; proposal?: EcOProposal; error?: string }> {
    if (params.amount <= 0) {
      return { success: false, error: 'Proposal amount must be greater than 0.' };
    }
    const code = formatConnectionCode(params.recipientCode);
    const conn = this.connections.find((c) => c.peerCode === code);
    const recipientUserId = conn?.peerUserId || code;

    const propId = `prop_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const proposal: EcOProposal = {
      id: propId,
      participants: [this.activeUserId || 'local_user', recipientUserId],
      connectionId: conn?.id,
      senderUserId: this.activeUserId || 'local_user',
      senderName: this.userDisplayName,
      senderCode: this.myConnectionCode,
      recipientUserId: recipientUserId,
      recipientName: params.recipientName,
      recipientCode: code,
      originalSenderType: params.type,
      recipientPerspectiveType: invertProposalDirection(params.type),
      amount: params.amount,
      isRepayment: Boolean(params.isRepayment),
      date: params.date,
      note: params.note || '',
      payMethodId: params.payMethodId || this.paymentMethods[0]?.id || 'cash',
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    await this.addProposal(proposal);
    return { success: true, proposal };
  }

  async addProposal(proposal: EcOProposal): Promise<void> {
    this.proposals = [proposal, ...this.proposals.filter((p) => p.id !== proposal.id)];
    this.saveToLocalStorageCache('proposals', this.proposals);

    try {
      localStorage.setItem(`eco_shared_proposals_${proposal.id}`, JSON.stringify(proposal));
    } catch {}

    if (isFirebaseConfigured() && db) {
      try {
        await this.setDocSafe(doc(db, 'proposals', proposal.id), proposal);
      } catch (err) {
        console.warn('Firestore proposal write error:', err);
      }
    }
    this.notify();
  }

  async updateProposal(proposal: EcOProposal): Promise<void> {
    this.proposals = this.proposals.map((p) => (p.id === proposal.id ? proposal : p));
    this.saveToLocalStorageCache('proposals', this.proposals);

    try {
      localStorage.setItem(`eco_shared_proposals_${proposal.id}`, JSON.stringify(proposal));
    } catch {}

    if (isFirebaseConfigured() && db) {
      try {
        await this.setDocSafe(doc(db, 'proposals', proposal.id), proposal, { merge: true });
      } catch (err) {
        console.warn('Firestore proposal update error:', err);
      }
    }
    this.notify();
  }

  async acceptProposal(proposalId: string, payMethodId: string): Promise<{ success: boolean; error?: string }> {
    const prop = this.proposals.find((p) => p.id === proposalId);
    if (!prop) return { success: false, error: 'Proposal not found' };
    if (prop.status !== 'pending' && prop.status !== 'disputed') {
      return { success: false, error: `Proposal already ${prop.status}` };
    }

    const updatedProp: EcOProposal = {
      ...prop,
      status: 'accepted',
      updatedAt: Date.now()
    };

    // The other peer from current user's perspective
    const isRecipient = prop.senderUserId !== this.activeUserId;
    const peerName = isRecipient ? prop.senderName : prop.recipientName;
    const peerCode = isRecipient ? prop.senderCode : prop.recipientCode;
    const peerUid = isRecipient ? prop.senderUserId : prop.recipientUserId;

    let person = this.people.find(
      (p) =>
        (peerCode && p.connectionCode === peerCode) ||
        (peerUid && p.connectedUserId === peerUid) ||
        p.name.toLowerCase() === peerName.toLowerCase()
    );

    if (!person) {
      person = {
        id: `person_peer_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`,
        name: peerName,
        isConnected: true,
        connectionCode: peerCode,
        connectedUserId: peerUid,
        createdAt: new Date().toISOString()
      };
      await this.addPerson(person);
    } else if (!person.isConnected) {
      await this.updatePerson({
        ...person,
        isConnected: true,
        connectionCode: peerCode || person.connectionCode,
        connectedUserId: peerUid || person.connectedUserId
      });
    }

    // Direction: recipientPerspectiveType if accepting received proposal; originalSenderType if self-accepting
    const txType = isRecipient ? prop.recipientPerspectiveType : prop.originalSenderType;

    const txDesc = prop.note
      ? `${prop.note} (via EcO Proposal)`
      : prop.isRepayment
      ? `Repayment confirmed with ${peerName}`
      : `Shared loan with ${peerName}`;

    const newTx: PeerTransactionRecord = {
      id: `tx_prop_${prop.id}_${isRecipient ? 'rec' : 'sender'}`,
      personId: person.id,
      type: txType,
      amount: prop.amount,
      totalAmount: prop.amount,
      payMethodId: payMethodId || this.paymentMethods[0]?.id || 'cash',
      tag: prop.isRepayment ? 'Repayment' : 'Shared Debt',
      description: txDesc,
      date: prop.date,
      timestamp: Date.now(),
      status: 'accepted',
      proposalId: prop.id
    };
    await this.addTransaction(newTx);

    // Update proposal document in Firestore / localStorage
    await this.updateProposal(updatedProp);
    return { success: true };
  }

  async disputeProposal(proposalId: string, reason: string): Promise<{ success: boolean; error?: string }> {
    const prop = this.proposals.find((p) => p.id === proposalId);
    if (!prop) return { success: false, error: 'Proposal not found' };

    const updated: EcOProposal = {
      ...prop,
      status: 'disputed',
      disputeReason: reason.trim() || 'Amount or terms disputed',
      updatedAt: Date.now()
    };
    await this.updateProposal(updated);
    return { success: true };
  }

  async rejectProposal(proposalId: string): Promise<void> {
    const prop = this.proposals.find((p) => p.id === proposalId);
    if (!prop) return;
    const updated: EcOProposal = {
      ...prop,
      status: 'rejected',
      updatedAt: Date.now()
    };
    await this.updateProposal(updated);
  }

  async saveIssueReport(report: IssueReport): Promise<void> {
    if (isFirebaseConfigured() && db && this.activeUserId) {
      try {
        await this.setDocSafe(doc(db, 'users', this.activeUserId, 'issueReports', report.id), report);
      } catch (err) {
        console.warn('Could not post issue report:', err);
      }
    }
  }

  // ============================================================================
  // BACKUP IMPORT & EXPORT (WITH IDEMPOTENCY / DEDUPLICATION)
  // ============================================================================

  exportBackup(): EcoBackupV1 {
    const methods = this.getPaymentMethods();
    const cashMethod = methods.find((m) => m.type === 'cash');
    const bkashMethod = methods.find((m) => m.name.toLowerCase().includes('bkash'));
    const nagadMethod = methods.find((m) => m.name.toLowerCase().includes('nagad'));

    return {
      format: 'eco-backup',
      formatVersion: 1,
      exportedAt: new Date().toISOString(),
      app: {
        name: 'EcO',
        purpose: 'Personal Finance & Expense Tracker for Bangladesh'
      },
      timestampEncoding: 'firestore-v1',
      data: {
        settings: [
          {
            id: 'main',
            fields: {
              ...this.getSettings()
            }
          }
        ],
        openingBalances: [
          {
            id: 'current',
            fields: {
              cash: cashMethod?.openingBalance || 0,
              bkash: bkashMethod?.openingBalance || 0,
              nagad: nagadMethod?.openingBalance || 0,
              date: new Date().toISOString().split('T')[0]
            }
          }
        ],
        paymentMethods: methods.map((m) => ({ id: m.id, fields: { ...m } })),
        people: this.people.map((p) => ({ id: p.id, fields: { ...p } })),
        expenses: this.expenses.map((e) => ({ id: e.id, fields: { ...e } })),
        recurringExpenses: this.recurringExpenses.map((r) => ({ id: r.id, fields: { ...r } })),
        earnings: this.earnings.map((ea) => ({ id: ea.id, fields: { ...ea } })),
        transfers: this.transfers.map((t) => ({ id: t.id, fields: { ...t } })),
        transactions: this.transactions.map((tx) => ({ id: tx.id, fields: { ...tx } })),
        sources: this.sources.map((s) => ({ id: s.id, fields: { ...s } }))
      },
      integrity: {
        complete: true,
        counts: {
          settings: 1,
          paymentMethods: methods.length,
          people: this.people.length,
          expenses: this.expenses.length,
          recurringExpenses: this.recurringExpenses.length,
          earnings: this.earnings.length,
          transfers: this.transfers.length,
          transactions: this.transactions.length,
          sources: this.sources.length
        }
      }
    };
  }

  async importBackup(backup: EcoBackupV1): Promise<{ importedCount: number; skippedCount: number }> {
    const domainData = migrateBackupV1ToDomain(backup);
    let importedCount = 0;
    let skippedCount = 0;

    // Deduplication Set of existing IDs
    const existingExpenseIds = new Set(this.expenses.map((e) => e.id));
    const existingEarningIds = new Set(this.earnings.map((e) => e.id));
    const existingTransferIds = new Set(this.transfers.map((t) => t.id));
    const existingPersonIds = new Set(this.people.map((p) => p.id));
    const existingTxIds = new Set(this.transactions.map((t) => t.id));

    // 1. Settings
    if (domainData.settings) {
      await this.saveSettings(domainData.settings);
    }

    // 2. Methods
    for (const m of domainData.paymentMethods) {
      const existing = this.paymentMethods.find(
        (existingM) =>
          existingM.id === m.id ||
          (existingM.name.trim().toLowerCase() === m.name.trim().toLowerCase() && existingM.type === m.type) ||
          (existingM.type === 'cash' && m.type === 'cash')
      );

      if (existing) {
        const oldId = m.id;
        const newId = existing.id;
        const updatedMethod = {
          ...existing,
          openingBalance: m.openingBalance !== undefined ? m.openingBalance : existing.openingBalance,
          isActive: true
        };
        await this.savePaymentMethod(updatedMethod);

        if (oldId !== newId) {
          domainData.expenses.forEach((e) => { if (e.payMethodId === oldId) e.payMethodId = newId; });
          domainData.recurringExpenses.forEach((r) => { if (r.payMethodId === oldId) r.payMethodId = newId; });
          domainData.earnings.forEach((ea) => { if (ea.payMethodId === oldId) ea.payMethodId = newId; });
          domainData.transfers.forEach((tr) => {
            if (tr.fromMethodId === oldId) tr.fromMethodId = newId;
            if (tr.toMethodId === oldId) tr.toMethodId = newId;
          });
          domainData.transactions.forEach((tx) => { if (tx.payMethodId === oldId) tx.payMethodId = newId; });
        }
      } else {
        await this.savePaymentMethod(m);
      }
    }

    // 3. People (Deduplicate)
    for (const p of domainData.people) {
      if (!existingPersonIds.has(p.id)) {
        await this.addPerson(p);
        existingPersonIds.add(p.id);
        importedCount++;
      } else {
        skippedCount++;
      }
    }

    // 4. Expenses (Deduplicate)
    for (const exp of domainData.expenses) {
      if (!existingExpenseIds.has(exp.id)) {
        await this.addExpense(exp);
        existingExpenseIds.add(exp.id);
        importedCount++;
      } else {
        skippedCount++;
      }
    }

    // 4b. Recurring Expenses (Deduplicate)
    const existingRecurringIds = new Set(this.recurringExpenses.map((r) => r.id));
    for (const rec of domainData.recurringExpenses) {
      if (!existingRecurringIds.has(rec.id)) {
        await this.addRecurringExpense(rec);
        existingRecurringIds.add(rec.id);
        importedCount++;
      } else {
        skippedCount++;
      }
    }

    // 5. Earnings (Deduplicate)
    for (const earn of domainData.earnings) {
      if (!existingEarningIds.has(earn.id)) {
        await this.addEarning(earn);
        existingEarningIds.add(earn.id);
        importedCount++;
      } else {
        skippedCount++;
      }
    }

    // 6. Transfers (Deduplicate)
    for (const tr of domainData.transfers) {
      if (!existingTransferIds.has(tr.id)) {
        await this.addTransfer(tr);
        existingTransferIds.add(tr.id);
        importedCount++;
      } else {
        skippedCount++;
      }
    }

    // 7. Transactions (Deduplicate)
    for (const tx of domainData.transactions) {
      if (!existingTxIds.has(tx.id)) {
        await this.addTransaction(tx);
        existingTxIds.add(tx.id);
        importedCount++;
      } else {
        skippedCount++;
      }
    }

    await this.setFirstLaunchDone(true);
    return { importedCount, skippedCount };
  }

  /**
   * Resets all user financial data in Firestore and local cache.
   */
  async resetAllUserData(): Promise<void> {
    if (isFirebaseConfigured() && db && this.activeUserId) {
      try {
        const collectionsToClean = [
          'expenses',
          'recurringExpenses',
          'earnings',
          'transfers',
          'people',
          'transactions',
          'sources',
          'notifications'
        ];
        for (const colName of collectionsToClean) {
          const snap = await getDocs(collection(db, 'users', this.activeUserId, colName));
          const batch = writeBatch(db);
          snap.docs.forEach((d) => batch.delete(d.ref));
          await batch.commit();
        }

        // Reset user root doc
        await this.setDocSafe(doc(db, 'users', this.activeUserId), {
          setupComplete: false,
          updatedAt: new Date().toISOString()
        }, { merge: true });
      } catch (err) {
        console.warn('Firestore reset warning:', err);
      }
    }

    // Clear local lists
    this.expenses = [];
    this.recurringExpenses = [];
    this.earnings = [];
    this.transfers = [];
    this.people = [];
    this.transactions = [];
    this.notifications = [];
    this.paymentMethods = createDefaultPaymentMethods();
    this.firstLaunchDone = false;

    // Reset local cache keys
    const keys = [
      'expenses',
      'recurringExpenses',
      'earnings',
      'transfers',
      'people',
      'transactions',
      'notifications',
      'setupComplete'
    ];
    keys.forEach((k) => localStorage.removeItem(this.getStorageKey(k)));
    this.saveToLocalStorageCache('paymentMethods', this.paymentMethods);

    this.notify();
  }

  /**
   * Alias for resetting all data.
   */
  async resetAllData(): Promise<void> {
    await this.resetAllUserData();
  }

  /**
   * Alias for importBackup to maintain backwards compatibility.
   */
  async importLegacyBackup(data: any): Promise<void> {
    await this.importBackup(data);
  }

  /**
   * Alias for exportBackup to maintain backwards compatibility.
   */
  exportBackupV1(): EcoBackupV1 {
    return this.exportBackup();
  }
}

export const repository = new HybridFirebaseRepository();
