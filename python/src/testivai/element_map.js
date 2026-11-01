/**
 * AUTO-GENERATED — DO NOT EDIT.
 *
 * Canonical element-map collector, emitted from
 *   packages/witness/src/capture/element-map.ts
 * by
 *   scripts/generate-element-map-asset.js
 *
 * Every TestivAI adapter injects this exact function so that element maps
 * are identical across languages sharing one baseline directory. Edit the
 * TypeScript source and re-run the generator; CI fails if this file is
 * stale.
 *
 * Default element cap: 3000
 *
 * Call form (each adapter wraps it the same way):
 *   return (<this function>)(document, window, <maxElements>, <ignoreSelectors>);
 */
function collectElementMap(doc, win, maxElements, ignoreSelectors = [], idAttributes = []) {
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
    function fnv1a(str) {
        var h = 0x811c9dc5;
        for (var i = 0; i < str.length; i++) {
            h ^= str.charCodeAt(i);
            h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
        }
        return ('0000000' + h.toString(16)).slice(-8);
    }
    function segment(el) {
        var tag = el.tagName.toLowerCase();
        var cls = '';
        if (el.classList && el.classList.length > 0) {
            cls = '.' + el.classList[0];
        }
        var parent = el.parentElement;
        if (!parent)
            return tag + cls;
        var sameTag = 0;
        var index = 0;
        for (var i = 0; i < parent.children.length; i++) {
            var sib = parent.children[i];
            if (sib.tagName === el.tagName) {
                sameTag++;
                if (sib === el)
                    index = sameTag;
            }
        }
        return sameTag > 1 ? tag + cls + ':nth-of-type(' + index + ')' : tag + cls;
    }
    // Anchors (opt-in). Plain attribute names only: anything else could not
    // be written into a selector unescaped.
    var anchorAttrs = [];
    if (idAttributes && idAttributes.length > 0) {
        for (var a = 0; a < idAttributes.length; a++) {
            var attrName = idAttributes[a];
            if (typeof attrName === 'string' && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(attrName) && anchorAttrs.indexOf(attrName) < 0) {
                anchorAttrs.push(attrName);
            }
        }
    }
    var anchorCounts = Object.create(null);
    function anchorValue(el, name) {
        if (typeof el.getAttribute !== 'function')
            return null;
        var v = el.getAttribute(name);
        // Empty identifies nothing; NUL cannot be matched by any selector.
        return typeof v === 'string' && v !== '' && v.indexOf('\u0000') < 0 ? v : null;
    }
    function cssString(v) {
        var out = '';
        for (var i = 0; i < v.length; i++) {
            var ch = v.charAt(i);
            var code = v.charCodeAt(i);
            if (code < 0x20 || code === 0x7f)
                out += '\\' + code.toString(16) + ' ';
            else if (ch === '\\' || ch === '"' || ch === '>')
                out += '\\' + ch;
            else
                out += ch;
        }
        return out;
    }
    function anchorOf(el) {
        for (var i = 0; i < anchorAttrs.length; i++) {
            var v = anchorValue(el, anchorAttrs[i]);
            if (v !== null && anchorCounts[anchorAttrs[i] + '=' + v] === 1) {
                return el.tagName.toLowerCase() + '[' + anchorAttrs[i] + '="' + cssString(v) + '"]';
            }
        }
        return null;
    }
    function pathOf(el, stopAt) {
        var parts = [];
        var node = el;
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
    var out = [];
    var body = doc.body;
    if (!body)
        return out;
    // Count every value over the whole document (skipped and ignored
    // elements included), so whether a value is unique never depends on
    // which elements the walk below keeps.
    if (anchorAttrs.length > 0) {
        var all = [body];
        while (all.length > 0) {
            var counted = all.pop();
            for (var n = 0; n < anchorAttrs.length; n++) {
                var idValue = anchorValue(counted, anchorAttrs[n]);
                if (idValue !== null) {
                    var key = anchorAttrs[n] + '=' + idValue;
                    anchorCounts[key] = (anchorCounts[key] || 0) + 1;
                }
            }
            for (var k = 0; k < counted.children.length; k++)
                all.push(counted.children[k]);
        }
    }
    var stack = [body];
    while (stack.length > 0 && out.length < maxElements) {
        var el = stack.pop();
        // The consistency rule: elements covered by ignoreSelectors are
        // excluded from pixels and the DOM snapshot — they must be excluded
        // from the element map too (subtree included), or their dynamic
        // styles would trip the style fingerprint they were meant to escape.
        var ignored = false;
        if (ignoreSelectors.length > 0 && typeof el.matches === 'function') {
            for (var g = 0; g < ignoreSelectors.length; g++) {
                try {
                    if (el.matches(ignoreSelectors[g])) {
                        ignored = true;
                        break;
                    }
                }
                catch (e) {
                    // invalid selector — never breaks the walk
                }
            }
        }
        if (ignored)
            continue; // skip element AND subtree
        var rect = el.getBoundingClientRect();
        if (rect.width >= 4 && rect.height >= 4) {
            var styleParts = [];
            var hidden = false;
            try {
                var cs = win.getComputedStyle(el);
                for (var p = 0; p < STYLE_PROPS.length; p++) {
                    var value = cs.getPropertyValue(STYLE_PROPS[p]);
                    if (STYLE_PROPS[p] === 'visibility' && value === 'hidden')
                        hidden = true;
                    styleParts.push(STYLE_PROPS[p] + ':' + value);
                }
            }
            catch (e) {
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
