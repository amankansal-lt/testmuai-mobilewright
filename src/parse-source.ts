import type { Platform, ViewNode } from '@mobilewright/protocol';

// Appium's page source is XML: UiAutomator2 on Android, XCUITest on iOS. Both
// carry everything a ViewNode needs, but the state flags mobilecli reports
// natively (checked, selected, focused) have to be reconstructed from
// attributes here.

const NAMED_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
};

function decodeEntities(raw: string): string {
  if (!raw.includes('&')) return raw;
  return raw.replace(/&(?:amp|lt|gt|quot|apos|#x?[0-9a-fA-F]+);/g, (entity) => {
    const named = NAMED_ENTITIES[entity];
    if (named) return named;
    const hex = /^&#x([0-9a-fA-F]+);$/.exec(entity);
    if (hex) return String.fromCodePoint(parseInt(hex[1], 16));
    const dec = /^&#(\d+);$/.exec(entity);
    if (dec) return String.fromCodePoint(parseInt(dec[1], 10));
    return entity;
  });
}

function parseAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw)) !== null) {
    attrs[match[1]] = decodeEntities(match[2]);
  }
  return attrs;
}

const ANDROID_EDITABLE = /edittext|autocomplete|textinput|searchview/i;
const IOS_EDITABLE = /textfield|securetextfield|searchfield|textview/i;
const SWITCH_LIKE = /switch|toggle|checkbox/i;

// Document wrappers with no geometry of their own. The iOS application element
// is deliberately NOT here: it has real bounds and the chain query's
// bounds-containment fallback relies on them.
const WRAPPER_TAGS = new Set(['hierarchy', 'AppiumAUT']);

function androidNode(tag: string, attrs: Record<string, string>): ViewNode {
  let x = 0, y = 0, width = 0, height = 0;
  const bounds = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(attrs['bounds'] ?? '');
  if (bounds) {
    x = Number(bounds[1]);
    y = Number(bounds[2]);
    width = Number(bounds[3]) - x;
    height = Number(bounds[4]) - y;
  }

  const cls = attrs['class'] || tag;
  const text = attrs['text'] || undefined;
  const hint = attrs['hint'] || undefined;
  // An empty Android field reports its hint as `text`, so text === hint means
  // the field is empty. Mirroring real text into `value` is what makes
  // toHaveValue()/toBeEmpty() and fill()'s clear-verify read true state.
  const editable = ANDROID_EDITABLE.test(cls);

  return {
    type: cls,
    text,
    label: attrs['content-desc'] || undefined,
    identifier: attrs['resource-id'] || undefined,
    resourceId: attrs['resource-id'] || undefined,
    value: editable && text && text !== hint ? text : undefined,
    placeholder: hint,
    isVisible: attrs['displayed'] !== 'false',
    isEnabled: attrs['enabled'] !== 'false',
    isSelected: attrs['selected'] === 'true',
    isFocused: attrs['focused'] === 'true',
    isChecked: attrs['checked'] === 'true',
    bounds: { x, y, width, height },
    children: [],
    raw: { ...attrs },
  };
}

export type VisibilityMode = 'native' | 'bounds';

function iosNode(tag: string, attrs: Record<string, string>, visibility: VisibilityMode): ViewNode {
  const type = attrs['type'] || tag;
  const rawValue = attrs['value'] || undefined;
  const declaredPlaceholder = attrs['placeholderValue'] || undefined;
  const editable = IOS_EDITABLE.test(type);

  // XCUITest mirrors the placeholder into `value` while a field is empty, and
  // many driver builds omit placeholderValue entirely. A value that merely
  // echoes the placeholder or label on an editable field is not content.
  const placeholderEcho = editable && rawValue !== undefined &&
    (rawValue === declaredPlaceholder ||
      (!declaredPlaceholder && (rawValue === attrs['label'] || rawValue === attrs['name'])));

  // XCUITest has no `checked` attribute: switches report "1"/"0" in value.
  // mobilecli does not derive this, so toBeChecked() fails there and passes here.
  const isChecked = SWITCH_LIKE.test(type) && (rawValue === '1' || rawValue === 'true');

  return {
    type,
    // Text lives in label/value on iOS; mirroring label into text is what makes
    // getByText() and hasText filters behave the same on both platforms.
    text: attrs['label'] || undefined,
    label: attrs['label'] || attrs['name'] || undefined,
    identifier: attrs['name'] || undefined,
    value: placeholderEcho ? undefined : rawValue,
    placeholder: declaredPlaceholder ?? (placeholderEcho ? rawValue : undefined),
    // XCUITest's `visible` is stricter than mobilecli's: an element drawn under
    // a sibling (a SwiftUI Stepper over its own label) is reported invisible
    // even though it is on screen. 'bounds' mode judges by geometry instead,
    // which is what a suite developed against local mobilecli expects.
    isVisible: visibility === 'bounds'
      ? Number(attrs['width'] ?? 0) > 0 && Number(attrs['height'] ?? 0) > 0
      : attrs['visible'] !== 'false',
    isEnabled: attrs['enabled'] !== 'false',
    isSelected: attrs['selected'] === 'true',
    isFocused: attrs['hasFocus'] === 'true',
    isChecked,
    bounds: {
      x: Number(attrs['x'] ?? 0),
      y: Number(attrs['y'] ?? 0),
      width: Number(attrs['width'] ?? 0),
      height: Number(attrs['height'] ?? 0),
    },
    children: [],
    raw: { ...attrs },
  };
}

/**
 * Parses Appium page-source XML into a ViewNode forest.
 *
 * Hand-rolled rather than using an XML parser: attribute values are always
 * quoted and escaped in this source, so a quote-aware tag scan is safe, and it
 * keeps the package dependency-free on a call that runs twice per user action.
 */
export function parseSourceXml(xml: string, platform: Platform, visibility: VisibilityMode = 'native'): ViewNode[] {
  const roots: ViewNode[] = [];
  const stack: ViewNode[][] = [roots];
  const makeNode = platform === 'android'
    ? (tag: string, attrs: Record<string, string>) => androidNode(tag, attrs)
    : (tag: string, attrs: Record<string, string>) => iosNode(tag, attrs, visibility);

  const tagRe = /<(\/?)([A-Za-z_][\w.$:-]*)((?:"[^"]*"|[^>])*)>/g;
  let match: RegExpExecArray | null;

  while ((match = tagRe.exec(xml)) !== null) {
    const [, closing, tag, attrsRaw] = match;

    if (closing) {
      if (stack.length > 1) stack.pop();
      continue;
    }

    const selfClosing = attrsRaw.trimEnd().endsWith('/');

    // Hoist wrapper children into the parent level so queries see real views.
    if (WRAPPER_TAGS.has(tag)) {
      if (!selfClosing) stack.push(stack[stack.length - 1]);
      continue;
    }

    const node = makeNode(tag, parseAttributes(attrsRaw));
    stack[stack.length - 1].push(node);
    if (!selfClosing) stack.push(node.children);
  }

  return roots;
}
