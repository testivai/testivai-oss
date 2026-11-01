/**
 * FROZEN REFERENCE — DO NOT REGENERATE.
 *
 * The element-map collector exactly as it was before the opt-in
 * `elementIdAttributes` option (copied from the generated asset
 * python/src/testivai/element_map.js at commit 9957153).
 * e2e/src/element-id-attributes.test.ts runs it and the current collector
 * in the same pages and requires byte-identical output when the option is
 * unset: baselines are matched by exact element path, so any drift in the
 * default output would drop existing users' style checks.
 */
function collectElementMap(doc, win, maxElements, ignoreSelectors = []) {
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
    function pathOf(el, stopAt) {
        var parts = [];
        var node = el;
        while (node && node !== stopAt.parentElement) {
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
