/**
 * Element-map capture — the layout + computed-style digest that powers
 * element attribution, shift classification, and the style fingerprint
 * on the comparison side (@testivai/witness).
 *
 * `collectElementMap` is a SELF-CONTAINED function (no imports, no
 * closures) so it can be serialized into the page with
 * `(${collectElementMap.toString()})(document, window, max)` — and unit
 * tested in Node against a duck-typed DOM. Keep it dependency-free.
 */

/**
 * Minimal structural types for the DOM surface this collector touches.
 *
 * This module lives in `@testivai/witness`, which compiles for Node and
 * deliberately has no `dom` lib — a Node package that can reference
 * `window` by accident is a footgun. The collector is injected into a
 * page as a string and unit-tested against a duck-typed DOM, so
 * structural types are both sufficient and closer to how it is used.
 */
export interface ElementLike {
  tagName: string;
  classList: { length: number; [index: number]: string };
  children: ArrayLike<ElementLike>;
  parentElement: ElementLike | null;
  getBoundingClientRect(): { x: number; y: number; width: number; height: number };
  matches?(selector: string): boolean;
  /** Read only when `idAttributes` is non-empty. */
  getAttribute?(name: string): string | null;
}

export interface DocumentLike {
  body: ElementLike;
}

export interface WindowLike {
  devicePixelRatio: number;
  scrollX: number;
  scrollY: number;
  getComputedStyle(el: ElementLike): { getPropertyValue(prop: string): string };
}

export interface CollectedElement {
  path: string;
  x: number;
  y: number;
  width: number;
  height: number;
  styleHash: string;
}

/**
 * Walk the document and produce [{path, rect, styleHash}] in document
 * coordinates (DPR-scaled to match full-page screenshot pixels).
 *
 * - `path` is deterministic: tag + first class + :nth-of-type when the
 *   element has same-tag element siblings.
 * - With `idAttributes` (opt-in, config `elementIdAttributes`), the path
 *   starts at the nearest ancestor-or-self carrying one of those attributes
 *   with a non-empty value no other element in the document shares:
 *   `div[data-testid="board"] > div.css-146c3p1`. The first listed
 *   attribute that qualifies wins; a duplicated value is not an anchor, so
 *   the walk goes on upward (paths stay unique). Values are escaped as CSS
 *   strings, `>` included, so ' > ' only ever separates segments. Content
 *   inserted above an anchor no longer renumbers what is inside it, which
 *   is what lets a moved element read as a shift. Empty or absent: the
 *   attributes are never read and the paths are exactly as before.
 * - Elements smaller than 4×4 px and invisible elements are skipped.
 * - The walk is depth-first and capped at `maxElements`.
 * - `styleHash` digests a fixed, documented list of computed properties
 *   (FNV-1a 32-bit, hex) — deterministic for identical rendering.
 */
export function collectElementMap(
  doc: DocumentLike,
  win: WindowLike,
  maxElements: number,
  ignoreSelectors: string[] = [],
  idAttributes: string[] = [],
): CollectedElement[] {
  var STYLE_PROPS = [
    'color', 'background-color', 'background-image',
    'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
    'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
    'border-top-style', 'border-bottom-style', 'border-radius',
    'font-family', 'font-size', 'font-weight', 'font-style', 'line-height',
    'text-align', 'text-transform', 'letter-spacing',
    'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'display', 'opacity', 'visibility', 'box-shadow',
  ];

  function fnv1a(str: string): string {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ('0000000' + h.toString(16)).slice(-8);
  }

  function segment(el: ElementLike): string {
    var tag = el.tagName.toLowerCase();
    var cls = '';
    if (el.classList && el.classList.length > 0) {
      cls = '.' + el.classList[0];
    }
    var parent = el.parentElement;
    if (!parent) return tag + cls;
    var sameTag = 0;
    var index = 0;
    for (var i = 0; i < parent.children.length; i++) {
      var sib = parent.children[i];
      if (sib.tagName === el.tagName) {
        sameTag++;
        if (sib === el) index = sameTag;
      }
    }
    return sameTag > 1 ? tag + cls + ':nth-of-type(' + index + ')' : tag + cls;
  }

  // Anchors (opt-in). Plain attribute names only: anything else could not
  // be written into a selector unescaped.
  var anchorAttrs: string[] = [];
  if (idAttributes && idAttributes.length > 0) {
    for (var a = 0; a < idAttributes.length; a++) {
      var attrName = idAttributes[a];
      if (typeof attrName === 'string' && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(attrName) && anchorAttrs.indexOf(attrName) < 0) {
        anchorAttrs.push(attrName);
      }
    }
  }
  var anchorCounts: Record<string, number> = Object.create(null);

  function anchorValue(el: ElementLike, name: string): string | null {
    if (typeof el.getAttribute !== 'function') return null;
    var v = el.getAttribute(name);
    // Empty identifies nothing; NUL cannot be matched by any selector.
    return typeof v === 'string' && v !== '' && v.indexOf('\u0000') < 0 ? v : null;
  }

  function cssString(v: string): string {
    var out = '';
    for (var i = 0; i < v.length; i++) {
      var ch = v.charAt(i);
      var code = v.charCodeAt(i);
      if (code < 0x20 || code === 0x7f) out += '\\' + code.toString(16) + ' ';
      else if (ch === '\\' || ch === '"' || ch === '>') out += '\\' + ch;
      else out += ch;
    }
    return out;
  }

  function anchorOf(el: ElementLike): string | null {
    for (var i = 0; i < anchorAttrs.length; i++) {
      var v = anchorValue(el, anchorAttrs[i]);
      if (v !== null && anchorCounts[anchorAttrs[i] + '=' + v] === 1) {
        return el.tagName.toLowerCase() + '[' + anchorAttrs[i] + '="' + cssString(v) + '"]';
      }
    }
    return null;
  }

  function pathOf(el: ElementLike, stopAt: ElementLike): string {
    var parts: string[] = [];
    var node: ElementLike | null = el;
    while (node && node !== stopAt.parentElement) {
      if (anchorAttrs.length > 0) {
        var anchor = anchorOf(node);
        if (anchor !== null) {
          parts.unshift(anchor);
          break;
        }
      }
      parts.unshift(segment(node));
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  var dpr = win.devicePixelRatio || 1;
  var scrollX = win.scrollX || 0;
  var scrollY = win.scrollY || 0;
  var out: CollectedElement[] = [];
  var body = doc.body;
  if (!body) return out;

  // Count every value over the whole document (skipped and ignored
  // elements included), so whether a value is unique never depends on
  // which elements the walk below keeps.
  if (anchorAttrs.length > 0) {
    var all: ElementLike[] = [body];
    while (all.length > 0) {
      var counted = all.pop() as ElementLike;
      for (var n = 0; n < anchorAttrs.length; n++) {
        var idValue = anchorValue(counted, anchorAttrs[n]);
        if (idValue !== null) {
          var key = anchorAttrs[n] + '=' + idValue;
          anchorCounts[key] = (anchorCounts[key] || 0) + 1;
        }
      }
      for (var k = 0; k < counted.children.length; k++) all.push(counted.children[k]);
    }
  }

  var stack: ElementLike[] = [body];
  while (stack.length > 0 && out.length < maxElements) {
    var el = stack.pop() as ElementLike;

    // The consistency rule: elements covered by ignoreSelectors are
    // excluded from pixels and the DOM snapshot — they must be excluded
    // from the element map too (subtree included), or their dynamic
    // styles would trip the style fingerprint they were meant to escape.
    var ignored = false;
    if (ignoreSelectors.length > 0 && typeof el.matches === 'function') {
      for (var g = 0; g < ignoreSelectors.length; g++) {
        try {
          if (el.matches!(ignoreSelectors[g])) { ignored = true; break; }
        } catch (e) {
          // invalid selector — never breaks the walk
        }
      }
    }
    if (ignored) continue; // skip element AND subtree

    var rect = el.getBoundingClientRect();
    if (rect.width >= 4 && rect.height >= 4) {
      var styleParts: string[] = [];
      var hidden = false;
      try {
        var cs = win.getComputedStyle(el);
        for (var p = 0; p < STYLE_PROPS.length; p++) {
          var value = cs.getPropertyValue(STYLE_PROPS[p]);
          if (STYLE_PROPS[p] === 'visibility' && value === 'hidden') hidden = true;
          styleParts.push(STYLE_PROPS[p] + ':' + value);
        }
      } catch (e) {
        // styleHash stays a digest of the empty string — still deterministic
      }
      // visibility:hidden elements paint no pixels, so their style changes
      // can never explain a pixel diff — keep them out of the map. Their
      // CHILDREN may override visibility, so the subtree still walks.
      if (!hidden) {
        out.push({
          path: pathOf(el, body),
          x: Math.round((rect.x + scrollX) * dpr),
          y: Math.round((rect.y + scrollY) * dpr),
          width: Math.round(rect.width * dpr),
          height: Math.round(rect.height * dpr),
          styleHash: fnv1a(styleParts.join(';')),
        });
      }
    }
    // Push children in reverse so the walk stays document-ordered
    for (var c = el.children.length - 1; c >= 0; c--) {
      stack.push(el.children[c]);
    }
  }
  return out;
}

/** Default element cap — bounds capture time and elements.json size. */
export const DEFAULT_MAX_ELEMENTS = 3000;

/**
 * The page-side expression evaluated by the adapter. Serializes the
 * collector so page code and unit-tested code are the same function.
 */
export function buildElementMapExpression(
  maxElements: number = DEFAULT_MAX_ELEMENTS,
  ignoreSelectors: string[] = [],
  idAttributes: string[] = [],
): string {
  const ids = normalizeElementIdAttributes(idAttributes);
  const extra = ids.length > 0 ? `, ${JSON.stringify(ids)}` : '';
  return `(${collectElementMap.toString()})(document, window, ${maxElements}, ${JSON.stringify(ignoreSelectors)}${extra})`;
}

/** A plain attribute name: safe to write into a selector unescaped. */
export const ID_ATTRIBUTE_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/**
 * The `elementIdAttributes` list an adapter uses: plain attribute names,
 * in order (the order is the precedence), each once. Anything else (not an
 * array, not a string, `ns:attr`, spaces, quotes) is dropped; the config
 * validation warns about it.
 */
export function normalizeElementIdAttributes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const name of value) {
    if (typeof name === 'string' && ID_ATTRIBUTE_NAME.test(name) && !out.includes(name)) out.push(name);
  }
  return out;
}
