/**
 * Re-export of the canonical element-map collector, which now lives in
 * `@testivai/witness` so every adapter (Playwright, Selenium, WebdriverIO)
 * injects the *same* page-side function. Keeping this shim means existing
 * imports and unit tests continue to work unchanged.
 */
export {
  collectElementMap,
  buildElementMapExpression,
  DEFAULT_MAX_ELEMENTS,
  normalizeElementIdAttributes,
} from '@testivai/witness';
export type { CollectedElement } from '@testivai/witness';
