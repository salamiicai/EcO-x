import {
  UserSettings,
  PaymentMethod,
  PaymentMethodType,
  ExpenseRecord,
  RecurringExpenseRecord,
  EarningRecord,
  TransferRecord,
  PeerTransactionRecord,
  PersonRecord,
  IncomeSource
} from './types';
import { BUILTIN_CASH_ID } from './paymentMethods';

export interface RawBackupRecord {
  id: string;
  fields: Record<string, any>;
}

export interface EcoBackupV1 {
  format: string;
  formatVersion: number;
  exportedAt: string;
  app: {
    name: string;
    purpose: string;
  };
  timestampEncoding?: string;
  data: {
    settings?: RawBackupRecord[];
    expenses?: RawBackupRecord[];
    recurringExpenses?: RawBackupRecord[];
    earnings?: RawBackupRecord[];
    transfers?: RawBackupRecord[];
    openingBalances?: RawBackupRecord[];
    sources?: RawBackupRecord[];
    people?: RawBackupRecord[];
    transactions?: RawBackupRecord[];
    shareLinks?: RawBackupRecord[];
    pendingRequests?: RawBackupRecord[];
    [key: string]: RawBackupRecord[] | undefined;
  };
  integrity: {
    complete: boolean;
    counts: Record<string, number>;
    redactedFields?: Record<string, number>;
    excluded?: string[];
  };
}

export interface BackupValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  exportDate: string;
  counts: Record<string, number>;
  representedMethods: {
    hasCash: boolean;
    hasBkash: boolean;
    hasNagad: boolean;
    otherMethods: string[];
  };
}

/**
 * Recursively restores tagged Firestore values:
 * { __type: "timestamp", seconds, nanoseconds, value } -> Date or ISO string
 */
export function restoreTaggedValues(val: any): any {
  if (val === null || val === undefined) return val;

  if (typeof val === 'object') {
    if (val.__type === 'timestamp') {
      if (typeof val.seconds === 'number') {
        return new Date(val.seconds * 1000).toISOString();
      }
      return val.value || new Date().toISOString();
    }
    if (val.__type === 'number' && val.value === 'NaN') {
      return NaN;
    }
    if (val.__type === 'reference') {
      return val.path;
    }
    if (Array.isArray(val)) {
      return val.map(restoreTaggedValues);
    }

    const result: Record<string, any> = {};
    for (const [k, v] of Object.entries(val)) {
      result[k] = restoreTaggedValues(v);
    }
    return result;
  }

  return val;
}

export function validateEcoBackupV1(jsonContent: string): {
  result: BackupValidationResult;
  parsedData?: EcoBackupV1;
} {
  const errors: string[] = [];
  const warnings: string[] = [];
  let parsed: any;

  try {
    parsed = JSON.parse(jsonContent);
  } catch (err: any) {
    return {
      result: {
        isValid: false,
        errors: [`Invalid JSON file: ${err.message}`],
        warnings: [],
        exportDate: '',
        counts: {},
        representedMethods: { hasCash: false, hasBkash: false, hasNagad: false, otherMethods: [] }
      }
    };
  }

  if (parsed.format !== 'eco-backup') {
    errors.push(`Invalid format identifier: "${parsed.format}". Expected "eco-backup".`);
  }

  if (parsed.formatVersion !== 1) {
    errors.push(`Unsupported formatVersion: ${parsed.formatVersion}. Expected 1.`);
  }

  if (!parsed.integrity || parsed.integrity.complete !== true) {
    errors.push('Backup file is marked incomplete or integrity header is missing.');
  }

  const counts = parsed.integrity?.counts || {};
  const data = parsed.data || {};

  // Check counts
  const expectedCollections = [
    'settings',
    'expenses',
    'recurringExpenses',
    'earnings',
    'transfers',
    'openingBalances',
    'sources',
    'people',
    'transactions'
  ];

  expectedCollections.forEach((col) => {
    const list = data[col];
    const expectedCount = counts[col];

    if (expectedCount !== undefined && list) {
      if (!Array.isArray(list)) {
        errors.push(`Collection "${col}" in data must be an array.`);
      } else if (list.length !== expectedCount) {
        errors.push(`Count mismatch for "${col}": found ${list.length}, expected ${expectedCount}.`);
      }
    }
  });

  // Detect represented payment methods
  const represented = {
    hasCash: false,
    hasBkash: false,
    hasNagad: false,
    otherMethods: [] as string[]
  };

  // Inspect paymentMethods array if present
  const pmList = data.paymentMethods || [];
  pmList.forEach((rec: RawBackupRecord) => {
    const f = rec.fields || {};
    const name = String(f.name || '').toLowerCase();
    const type = String(f.type || '').toLowerCase();
    if (name.includes('cash') || type === 'cash') represented.hasCash = true;
    else if (name.includes('bkash')) represented.hasBkash = true;
    else if (name.includes('nagad')) represented.hasNagad = true;
    else if (f.name && !represented.otherMethods.includes(f.name)) {
      represented.otherMethods.push(f.name);
    }
  });

  // Inspect openingBalances
  const openingList = data.openingBalances || [];
  openingList.forEach((rec: RawBackupRecord) => {
    const f = rec.fields || {};
    if (f.cash !== undefined && f.cash !== null) represented.hasCash = true;
    if (f.bkash !== undefined && f.bkash !== null) represented.hasBkash = true;
    if (f.nagad !== undefined && f.nagad !== null) represented.hasNagad = true;
    for (const [k, v] of Object.entries(f)) {
      if (['date', 'id', 'createdAt', 'timestamp', 'updatedAt', 'cash', 'bkash', 'nagad'].includes(k)) continue;
      if (typeof v === 'number' && !represented.otherMethods.includes(k)) {
        represented.otherMethods.push(k);
      }
    }
  });

  // Inspect transaction & expense payMethods
  const allTxList = [
    ...(data.expenses || []),
    ...(data.recurringExpenses || []),
    ...(data.earnings || []),
    ...(data.transactions || [])
  ];

  allTxList.forEach((rec: RawBackupRecord) => {
    const m = rec.fields?.payMethodId || rec.fields?.payMethod || rec.fields?.paymentMethodId || rec.fields?.paymentMethod || rec.fields?.method || rec.fields?.wallet;
    if (typeof m === 'string') {
      const lower = m.toLowerCase();
      if (lower.includes('cash')) represented.hasCash = true;
      else if (lower.includes('bkash')) represented.hasBkash = true;
      else if (lower.includes('nagad')) represented.hasNagad = true;
      else if (!represented.otherMethods.includes(m)) {
        represented.otherMethods.push(m);
      }
    }
  });

  // Inspect transfers
  (data.transfers || []).forEach((rec: RawBackupRecord) => {
    const fromM = rec.fields?.fromMethodId || rec.fields?.from || rec.fields?.fromMethod || rec.fields?.fromWallet;
    const toM = rec.fields?.toMethodId || rec.fields?.to || rec.fields?.toMethod || rec.fields?.toWallet;
    [fromM, toM].forEach((m) => {
      if (typeof m === 'string') {
        const lower = m.toLowerCase();
        if (lower.includes('cash')) represented.hasCash = true;
        else if (lower.includes('bkash')) represented.hasBkash = true;
        else if (lower.includes('nagad')) represented.hasNagad = true;
        else if (!represented.otherMethods.includes(m)) {
          represented.otherMethods.push(m);
        }
      }
    });
  });

  if (parsed.integrity?.redactedFields?.['shareLinks.hash']) {
    warnings.push('Share link hashes were redacted in the backup for security. Links can be regenerated securely on demand.');
  }

  return {
    result: {
      isValid: errors.length === 0,
      errors,
      warnings,
      exportDate: parsed.exportedAt || '',
      counts,
      representedMethods: represented
    },
    parsedData: parsed as EcoBackupV1
  };
}

/**
 * Converts validated EcoBackupV1 into EcO domain records
 */
export function migrateBackupV1ToDomain(backup: EcoBackupV1): {
  settings: UserSettings;
  paymentMethods: PaymentMethod[];
  expenses: ExpenseRecord[];
  recurringExpenses: RecurringExpenseRecord[];
  earnings: EarningRecord[];
  transfers: TransferRecord[];
  people: PersonRecord[];
  transactions: PeerTransactionRecord[];
  sources: IncomeSource[];
} {
  const data = backup.data || {};
  const now = new Date().toISOString();

  // 1. Settings
  let settings: UserSettings = {
    id: 'main',
    theme: 'dark',
    setupComplete: true,
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

  const rawSettings = data.settings?.[0]?.fields;
  if (rawSettings) {
    const cleanSettings = restoreTaggedValues(rawSettings);
    settings = {
      ...settings,
      budgetMode: cleanSettings.budgetMode || settings.budgetMode,
      directDailyBudget: cleanSettings.directDailyBudget ?? settings.directDailyBudget,
      monthlyIncome: cleanSettings.monthlyIncome ?? settings.monthlyIncome,
      monthlyFixed: cleanSettings.monthlyFixed ?? settings.monthlyFixed,
      monthlySavings: cleanSettings.monthlySavings ?? settings.monthlySavings,
      monthlyEmergency: cleanSettings.monthlyEmergency ?? settings.monthlyEmergency,
      bufferPct: cleanSettings.bufferPct ?? settings.bufferPct,
      cashoutChargeRate: cleanSettings.cashoutChargeRate ?? settings.cashoutChargeRate,
      categories: Array.isArray(cleanSettings.categories) ? cleanSettings.categories : settings.categories,
      tags: Array.isArray(cleanSettings.tags) ? cleanSettings.tags : settings.tags
    };
  }

  // 2. Discover and create payment methods
  const paymentMethods: PaymentMethod[] = [];
  const methodMap = new Map<string, string>(); // identifier / alias / name -> canonical methodId

  const rawOpening = restoreTaggedValues(data.openingBalances?.[0]?.fields || {});

  // Case A: Modern backup with explicit paymentMethods array
  if (Array.isArray(data.paymentMethods) && data.paymentMethods.length > 0) {
    data.paymentMethods.forEach((pmRec: RawBackupRecord) => {
      const f = restoreTaggedValues(pmRec.fields || {});
      const methodId = pmRec.id || f.id || `method_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
      const methodName = f.name || 'Unnamed Wallet';
      const methodType: PaymentMethodType =
        f.type ||
        (methodName.toLowerCase().includes('cash')
          ? 'cash'
          : methodName.toLowerCase().includes('bank')
          ? 'bank'
          : methodName.toLowerCase().includes('card')
          ? 'credit_card'
          : 'mobile_money');

      const method: PaymentMethod = {
        id: methodId,
        name: methodName,
        type: methodType,
        isBuiltIn: Boolean(f.isBuiltIn || methodId === BUILTIN_CASH_ID || methodType === 'cash'),
        isActive: f.isActive !== false,
        balance: Number(f.balance) || Number(f.openingBalance) || 0,
        openingBalance: Number(f.openingBalance) || 0,
        createdAt: f.createdAt || now,
        updatedAt: f.updatedAt || now,
        legacyNames: Array.isArray(f.legacyNames) ? f.legacyNames : [methodName, methodId]
      };

      paymentMethods.push(method);
      methodMap.set(method.id.toLowerCase(), method.id);
      methodMap.set(method.name.trim().toLowerCase(), method.id);
      if (method.legacyNames) {
        method.legacyNames.forEach((ln) => methodMap.set(ln.trim().toLowerCase(), method.id));
      }
    });
  } else {
    // Case B: Legacy backup with openingBalances + transaction scanning
    // Cash is always created
    const cashOpening =
      rawOpening.cash !== undefined && rawOpening.cash !== null
        ? Number(rawOpening.cash) || 0
        : 0;
    const cashMethod: PaymentMethod = {
      id: BUILTIN_CASH_ID,
      name: 'Cash',
      type: 'cash',
      isBuiltIn: true,
      isActive: true,
      balance: cashOpening,
      openingBalance: cashOpening,
      createdAt: now,
      updatedAt: now,
      legacyNames: ['cash', 'Cash', 'method_cash_default']
    };
    paymentMethods.push(cashMethod);
    methodMap.set('cash', cashMethod.id);
    methodMap.set(cashMethod.id.toLowerCase(), cashMethod.id);

    // Scan helper for method usage in transactions
    const matchesMethod = (nameQuery: string): boolean => {
      const q = nameQuery.toLowerCase();
      const inExp = (data.expenses || []).some((e) => {
        const m = String(e.fields?.payMethodId || e.fields?.payMethod || e.fields?.paymentMethodId || e.fields?.paymentMethod || e.fields?.method || e.fields?.wallet || '').toLowerCase();
        return m.includes(q);
      });
      const inRec = (data.recurringExpenses || []).some((r) => {
        const m = String(r.fields?.payMethodId || r.fields?.payMethod || r.fields?.paymentMethodId || r.fields?.paymentMethod || r.fields?.method || r.fields?.wallet || '').toLowerCase();
        return m.includes(q);
      });
      const inEarn = (data.earnings || []).some((ea) => {
        const m = String(ea.fields?.payMethodId || ea.fields?.payMethod || ea.fields?.paymentMethodId || ea.fields?.paymentMethod || ea.fields?.method || ea.fields?.wallet || '').toLowerCase();
        return m.includes(q);
      });
      const inTx = (data.transactions || []).some((t) => {
        const m = String(t.fields?.payMethodId || t.fields?.payMethod || t.fields?.paymentMethodId || t.fields?.paymentMethod || t.fields?.method || t.fields?.wallet || '').toLowerCase();
        return m.includes(q);
      });
      const inTransfer = (data.transfers || []).some((tr) => {
        const fM = String(tr.fields?.fromMethodId || tr.fields?.from || tr.fields?.fromMethod || tr.fields?.fromWallet || '').toLowerCase();
        const tM = String(tr.fields?.toMethodId || tr.fields?.to || tr.fields?.toMethod || tr.fields?.toWallet || '').toLowerCase();
        return fM.includes(q) || tM.includes(q);
      });
      return inExp || inRec || inEarn || inTx || inTransfer;
    };

    // Restore bKash ONLY if represented
    const hasBkash = (rawOpening.bkash !== undefined && rawOpening.bkash !== null) || matchesMethod('bkash');
    if (hasBkash) {
      const bkashOpening = Number(rawOpening.bkash) || 0;
      const bkashMethod: PaymentMethod = {
        id: 'method_bkash_migrated',
        name: 'bKash',
        type: 'mobile_money',
        isBuiltIn: false,
        isActive: true,
        balance: bkashOpening,
        openingBalance: bkashOpening,
        createdAt: now,
        updatedAt: now,
        legacyNames: ['bkash', 'bKash', 'method_bkash_migrated']
      };
      paymentMethods.push(bkashMethod);
      methodMap.set('bkash', bkashMethod.id);
      methodMap.set(bkashMethod.id.toLowerCase(), bkashMethod.id);
    }

    // Restore Nagad ONLY if represented
    const hasNagad = (rawOpening.nagad !== undefined && rawOpening.nagad !== null) || matchesMethod('nagad');
    if (hasNagad) {
      const nagadOpening = Number(rawOpening.nagad) || 0;
      const nagadMethod: PaymentMethod = {
        id: 'method_nagad_migrated',
        name: 'Nagad',
        type: 'mobile_money',
        isBuiltIn: false,
        isActive: true,
        balance: nagadOpening,
        openingBalance: nagadOpening,
        createdAt: now,
        updatedAt: now,
        legacyNames: ['nagad', 'Nagad', 'method_nagad_migrated']
      };
      paymentMethods.push(nagadMethod);
      methodMap.set('nagad', nagadMethod.id);
      methodMap.set(nagadMethod.id.toLowerCase(), nagadMethod.id);
    }

    // Check for custom wallets in openingBalances (e.g. cityBank, rocket, etc.)
    for (const [key, val] of Object.entries(rawOpening)) {
      if (['cash', 'bkash', 'nagad', 'date', 'id', 'createdAt', 'timestamp', 'updatedAt'].includes(key.toLowerCase())) continue;
      if (typeof val === 'number') {
        const customId = `method_${key.toLowerCase()}_migrated`;
        const customName = key.replace(/([A-Z])/g, ' $1').replace(/^./, (str) => str.toUpperCase()).trim();
        const customType: PaymentMethodType = customName.toLowerCase().includes('bank') ? 'bank' : 'mobile_money';
        const customMethod: PaymentMethod = {
          id: customId,
          name: customName,
          type: customType,
          isBuiltIn: false,
          isActive: true,
          balance: val,
          openingBalance: val,
          createdAt: now,
          updatedAt: now,
          legacyNames: [key, customName, customId]
        };
        paymentMethods.push(customMethod);
        methodMap.set(key.toLowerCase(), customId);
        methodMap.set(customName.toLowerCase(), customId);
        methodMap.set(customId.toLowerCase(), customId);
      }
    }
  }

  // Ensure cashMethod is available as fallback
  const cashObj = paymentMethods.find((m) => m.type === 'cash') || paymentMethods[0];
  const defaultCashId = cashObj ? cashObj.id : BUILTIN_CASH_ID;

  // Robust helper to resolve any payMethod identifier, alias, or name to canonical methodId
  const getMethodId = (rawInput: any): string => {
    if (rawInput === null || rawInput === undefined) return defaultCashId;
    const str = String(rawInput).trim();
    if (!str) return defaultCashId;

    // 1. Exact match on method.id
    const existingById = paymentMethods.find((m) => m.id === str);
    if (existingById) return existingById.id;

    // 2. Direct map match
    const lower = str.toLowerCase();
    if (methodMap.has(lower)) {
      return methodMap.get(lower)!;
    }

    // 3. Name or legacyNames match
    const existingByName = paymentMethods.find(
      (m) =>
        m.name.trim().toLowerCase() === lower ||
        m.legacyNames?.some((ln) => ln.trim().toLowerCase() === lower)
    );
    if (existingByName) return existingByName.id;

    // 4. Substring heuristics
    if (lower.includes('bkash')) {
      const bk = paymentMethods.find((m) => m.name.toLowerCase().includes('bkash'));
      if (bk) return bk.id;
    }
    if (lower.includes('nagad')) {
      const ng = paymentMethods.find((m) => m.name.toLowerCase().includes('nagad'));
      if (ng) return ng.id;
    }
    if (lower.includes('cash')) {
      return defaultCashId;
    }

    // 5. If not found in existing methods, dynamically register new custom method
    const newId = `method_${lower.replace(/[^a-z0-9]/g, '_')}_migrated`;
    const newMethod: PaymentMethod = {
      id: newId,
      name: str,
      type: lower.includes('bank') ? 'bank' : lower.includes('card') ? 'credit_card' : 'mobile_money',
      isBuiltIn: false,
      isActive: true,
      balance: 0,
      openingBalance: 0,
      createdAt: now,
      updatedAt: now,
      legacyNames: [str, newId]
    };
    paymentMethods.push(newMethod);
    methodMap.set(lower, newId);
    methodMap.set(newId.toLowerCase(), newId);
    return newId;
  };

  // 3. People
  const people: PersonRecord[] = (data.people || []).map((p) => {
    const f = restoreTaggedValues(p.fields || {});
    const personRecord: PersonRecord = {
      id: p.id,
      name: f.name || 'Unnamed Person',
      isConnected: false,
      createdAt: f.createdAt || now
    };
    if (f.phone) {
      personRecord.phone = String(f.phone).trim();
    }
    if (f.connectionCode) {
      personRecord.connectionCode = String(f.connectionCode).trim();
    }
    return personRecord;
  });

  // 4. Expenses
  const expenses: ExpenseRecord[] = (data.expenses || []).map((e) => {
    const f = restoreTaggedValues(e.fields || {});
    const rawMethod =
      f.payMethodId ??
      f.payMethod ??
      f.paymentMethodId ??
      f.paymentMethod ??
      f.method ??
      f.wallet;
    return {
      id: e.id,
      reason: f.reason || f.description || 'Expense',
      category: f.category || 'Other',
      description: f.description || '',
      amount: Number(f.amount) || 0,
      type: (f.type as any) || 'regular',
      payMethodId: getMethodId(rawMethod),
      date: f.date || now.split('T')[0],
      timestamp: typeof f.timestamp === 'number' ? f.timestamp : Date.now()
    };
  });

  // 5. Recurring Expenses
  const recurringExpenses: RecurringExpenseRecord[] = (data.recurringExpenses || []).map((r) => {
    const f = restoreTaggedValues(r.fields || {});
    const rawMethod =
      f.payMethodId ??
      f.payMethod ??
      f.paymentMethodId ??
      f.paymentMethod ??
      f.method ??
      f.wallet;
    return {
      id: r.id,
      reason: f.reason || 'Recurring Expense',
      category: f.category || 'Other',
      amount: Number(f.amount) || 0,
      perDay: Number(f.perDay) || 0,
      days: Number(f.days) || 30,
      startDate: f.startDate || now.split('T')[0],
      endDate: f.endDate || now.split('T')[0],
      payMethodId: getMethodId(rawMethod),
      timestamp: Date.now()
    };
  });

  // 6. Earnings
  const earnings: EarningRecord[] = (data.earnings || []).map((earn) => {
    const f = restoreTaggedValues(earn.fields || {});
    const rawMethod =
      f.payMethodId ??
      f.payMethod ??
      f.paymentMethodId ??
      f.paymentMethod ??
      f.method ??
      f.wallet;
    return {
      id: earn.id,
      source: f.source || 'Salary',
      description: f.description || '',
      amount: Number(f.amount) || 0,
      payMethodId: getMethodId(rawMethod),
      date: f.date || now.split('T')[0],
      timestamp: typeof f.timestamp === 'number' ? f.timestamp : Date.now()
    };
  });

  // 7. Transfers
  const transfers: TransferRecord[] = (data.transfers || []).map((tr) => {
    const f = restoreTaggedValues(tr.fields || {});
    const reqAmount = Number(f.requestedAmount) || Number(f.amount) || 0;
    const chargeApplied = Boolean(f.chargeApplied);
    const chargeAmount = Number(f.chargeAmount) || 0;
    const chargeRate = Number(f.chargeRate) || 0;
    const sourceDeducted = Number(f.sourceDeducted) || (reqAmount + chargeAmount);
    const rawFrom =
      f.fromMethodId ??
      f.from ??
      f.fromMethod ??
      f.fromWallet;
    const rawTo =
      f.toMethodId ??
      f.to ??
      f.toMethod ??
      f.toWallet;

    return {
      id: tr.id,
      fromMethodId: getMethodId(rawFrom),
      toMethodId: getMethodId(rawTo),
      requestedAmount: reqAmount,
      chargeApplied,
      chargeAmount,
      chargeRate,
      sourceDeducted,
      note: f.note || '',
      date: f.date || now.split('T')[0],
      timestamp: typeof f.timestamp === 'number' ? f.timestamp : Date.now()
    };
  });

  // 8. Transactions (Peer Give/Take)
  const transactions: PeerTransactionRecord[] = (data.transactions || []).map((tx) => {
    const f = restoreTaggedValues(tx.fields || {});
    const rawMethod =
      f.payMethodId ??
      f.payMethod ??
      f.paymentMethodId ??
      f.paymentMethod ??
      f.method ??
      f.wallet;
    return {
      id: tx.id,
      personId: f.personId || (people.find((p) => p.name === f.person)?.id) || 'unknown_person',
      type: (f.type as any) === 'take' ? 'take' : 'give',
      amount: Number(f.amount) || 0,
      totalAmount: Number(f.totalAmount) || Number(f.amount) || 0,
      payMethodId: getMethodId(rawMethod),
      tag: f.tag || 'Loan',
      description: f.description || '',
      date: f.date || now.split('T')[0],
      isOpening: Boolean(f.isOpening),
      fromRequest: Boolean(f.fromRequest),
      timestamp: typeof f.timestamp === 'number' ? f.timestamp : Date.now(),
      status: 'local'
    };
  });

  // 9. Sources
  const sources: IncomeSource[] = (data.sources || []).map((s) => {
    const f = restoreTaggedValues(s.fields || {});
    return {
      id: s.id,
      name: f.name || 'Income Source',
      description: f.description || '',
      createdAt: f.createdAt || now
    };
  });

  return {
    settings,
    paymentMethods,
    expenses,
    recurringExpenses,
    earnings,
    transfers,
    people,
    transactions,
    sources
  };
}

/**
 * Complete Sample Legacy eco-backup v1 Fixture for 1-click test import in Onboarding
 */
export const SAMPLE_ECO_BACKUP_V1: EcoBackupV1 = {
  format: 'eco-backup',
  formatVersion: 1,
  exportedAt: '2026-10-21T08:49:20.000Z',
  app: {
    name: 'EcO (Echo)',
    purpose: 'Personal finance tracker – full per-user data backup'
  },
  timestampEncoding: 'Human-readable note describing tagged Firestore values',
  data: {
    settings: [
      {
        id: 'main',
        fields: {
          budgetMode: 'direct',
          directDailyBudget: 800,
          monthlyIncome: 45000,
          monthlyFixed: 12000,
          monthlySavings: 5000,
          monthlyEmergency: 3000,
          bufferPct: 10,
          cashoutChargeRate: 2,
          categories: ['Food', 'Transport', 'Utilities', 'Family', 'Shopping', 'Health', 'Tech'],
          tags: ['Personal', 'Work', 'Office Lunch', 'Lending']
        }
      }
    ],
    openingBalances: [
      {
        id: 'current',
        fields: {
          cash: 1040,
          bkash: 8000,
          date: '2026-10-01'
        }
      }
    ],
    people: [
      {
        id: 'person_emon',
        fields: {
          name: 'Emon',
          phone: '+8801712345678',
          createdAt: {
            __type: 'timestamp',
            seconds: 1760000000,
            nanoseconds: 0
          }
        }
      },
      {
        id: 'person_tanvir',
        fields: {
          name: 'Tanvir',
          phone: '+8801812345678',
          createdAt: {
            __type: 'timestamp',
            seconds: 1760100000,
            nanoseconds: 0
          }
        }
      }
    ],
    expenses: [
      {
        id: 'exp_01',
        fields: {
          reason: 'Groceries & Fish',
          category: 'Food',
          description: 'Weekly bazaar at Kawran Bazar',
          amount: 450,
          type: 'regular',
          payMethod: 'cash',
          date: '2026-10-21',
          timestamp: 1761040000000
        }
      },
      {
        id: 'exp_02',
        fields: {
          reason: 'Metro Rail Card Recharge',
          category: 'Transport',
          description: 'Monthly pass top-up',
          amount: 200,
          type: 'regular',
          payMethod: 'bkash',
          date: '2026-10-22',
          timestamp: 1761100000000
        }
      }
    ],
    recurringExpenses: [],
    earnings: [
      {
        id: 'earn_01',
        fields: {
          source: 'Consulting Project',
          description: 'UI Design milestone 1 payment',
          amount: 5000,
          payMethod: 'bkash',
          date: '2026-10-15',
          timestamp: 1760500000000
        }
      }
    ],
    transfers: [
      {
        id: 'tr_01',
        fields: {
          from: 'bkash',
          to: 'cash',
          requestedAmount: 1000,
          chargeApplied: true,
          chargeAmount: 20,
          chargeRate: 2,
          sourceDeducted: 1020,
          note: 'ATM Cash out via Agent',
          date: '2026-10-18',
          timestamp: 1760750000000
        }
      }
    ],
    transactions: [
      {
        id: 'tx_emon_lend',
        fields: {
          person: 'Emon',
          personId: 'person_emon',
          type: 'give',
          amount: 500,
          totalAmount: 500,
          payMethod: 'bkash',
          tag: 'Lending',
          description: 'Urgent loan for medical bill',
          date: '2026-10-21',
          isOpening: false,
          timestamp: 1761000000000
        }
      }
    ],
    sources: [
      {
        id: 'src_consulting',
        fields: {
          name: 'Consulting Project',
          description: 'Freelance fintech engineering',
          createdAt: '2026-10-01'
        }
      }
    ],
    shareLinks: [],
    pendingRequests: []
  },
  integrity: {
    complete: true,
    counts: {
      settings: 1,
      openingBalances: 1,
      people: 2,
      expenses: 2,
      recurringExpenses: 0,
      earnings: 1,
      transfers: 1,
      transactions: 1,
      sources: 1,
      shareLinks: 0,
      pendingRequests: 0
    },
    redactedFields: {
      'shareLinks.hash': 0
    },
    excluded: [
      'shareHashes',
      'issueReports',
      'userDirectory',
      'connectionInvites',
      'connections',
      'sharedTransactions',
      'voidRequests',
      'admins',
      'adminAuditLog'
    ]
  }
};
