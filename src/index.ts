// moneyer - an LNURLcash (LUD-25) mint.
//
// A bearer note is an ordinary LUD-03 withdrawRequest link whose k1 IS the
// asset. This SERVICE mints them against a paid invoice whose preimage
// becomes the note's spend secret, honours rotate/split/merge/melt on the
// withdraw callback, signs every note it mints for offline verification,
// and holds the melt discipline: burn only on confirmed payment, restore
// only on confirmed non-payment, park everything else as pending.
//
// Independent implementation. Reference stack (dni, MIT):
//   spec    https://github.com/lnurl/luds/pull/301
//   mint    https://github.com/dni/lnurl-mint
//   wallet  https://github.com/dni/lnurl-wallet

export {configFromEnv, DEFAULTS, type MoneyerConfig, type BackendConfig} from './config.ts'
export {createMoneyer, type Moneyer, type MoneyerDeps} from './server.ts'
export {
  NoteStore,
  NotePendingError,
  NoteUnavailableError,
  OutputCollisionError,
  type NoteRow,
  type NoteState,
  type MeltRow,
  type MintInvoiceRow,
  type Liabilities
} from './store.ts'
export {createNoteSigner, noteIdSignatureDigest, type NoteSigner} from './signing.ts'
export {
  STATS_D_TAG,
  STATS_KIND,
  buildStats,
  canonicalJson,
  signStats,
  statsDigest,
  statsSnapshotContent,
  verifyStatsSignature,
  verifyStatsSnapshot,
  type MintStats
} from './stats.ts'
export {
  PaymentAlreadyKnownError,
  PaymentFailedError,
  PaymentPendingError,
  type LightningBackend,
  type NodeInfo,
  type PaymentOutcome
} from './backends/types.ts'
export {createFakeBackend, type FakeBackend, type FakePayMode} from './backends/fake.ts'
export {createClnBackend} from './backends/cln.ts'
export {createLndBackend} from './backends/lnd.ts'
export {fakeBolt11} from './backends/fake-bolt11.ts'
export {runMelt, reconcilePendingMelts, type MeltJob, type MeltDeps} from './melt.ts'
export {runAdmin, adminHelp, type AdminDeps} from './admin.ts'
