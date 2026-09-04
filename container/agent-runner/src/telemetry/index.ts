/**
 * Turn telemetry: what the current turn knows about itself, and its one-line
 * rendering. Providers write through `state`, the poll loop reads `footer`.
 */
export {
  accountName,
  recordAccountName,
  recordContextTokens,
  recordContextUsage,
  recordEffort,
  recordModel,
  recordRateLimits,
  recordUtilization,
  registerAccountResolver,
  registerModelShortener,
  registerRateLimitWindows,
  resetFooterTelemetry,
  telemetrySnapshot,
  type FooterUsage,
  type TelemetrySnapshot,
} from './state.js';
export { formatTokens, renderFooter } from './footer.js';
