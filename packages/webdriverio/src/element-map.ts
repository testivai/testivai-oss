import { buildElementMapExpression, type CollectedElement } from '@testivai/witness';

/** What the page reports: the shared collector's map plus where the viewport was. */
export interface PageElementMap {
  /** From the shared collector: document coordinates in device pixels. */
  elements: CollectedElement[];
  scrollX: number;
  scrollY: number;
  viewportWidth: number;
  viewportHeight: number;
  dpr: number;
}

/**
 * Page-side script: the same collector the Playwright and Selenium adapters
 * run (so all lanes produce identical maps), plus the viewport it was taken
 * in. WebdriverIO string scripts need an explicit `return`.
 */
export function elementMapScript(maxElements: number, ignoreSelectors: string[]): string {
  return (
    `return { elements: ${buildElementMapExpression(maxElements, ignoreSelectors)}, ` +
    'scrollX: window.scrollX || 0, scrollY: window.scrollY || 0, ' +
    'viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, ' +
    'dpr: window.devicePixelRatio || 1 };'
  );
}

export function isPageElementMap(value: unknown): value is PageElementMap {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    Array.isArray(v.elements) &&
    ['scrollX', 'scrollY', 'viewportWidth', 'viewportHeight', 'dpr'].every((k) => typeof v[k] === 'number')
  );
}

/**
 * WebDriver's Take Screenshot captures the viewport, while the collector
 * reports document coordinates. Keep only the elements inside the captured
 * viewport, moved into screenshot coordinates, so the map describes the
 * pixels that were actually compared.
 */
export function toViewportElementMap(page: PageElementMap): CollectedElement[] {
  const offsetX = Math.round(page.scrollX * page.dpr);
  const offsetY = Math.round(page.scrollY * page.dpr);
  const width = Math.round(page.viewportWidth * page.dpr);
  const height = Math.round(page.viewportHeight * page.dpr);
  return page.elements
    .map((e) => ({ ...e, x: e.x - offsetX, y: e.y - offsetY }))
    .filter((e) => e.x < width && e.x + e.width > 0 && e.y < height && e.y + e.height > 0);
}
