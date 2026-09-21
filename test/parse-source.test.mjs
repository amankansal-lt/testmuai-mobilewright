import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSourceXml } from '../dist/parse-source.js';

const ANDROID = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <android.widget.FrameLayout bounds="[0,0][1080,2400]" displayed="true" enabled="true">
    <android.widget.TextView text="Welcome" resource-id="com.example:id/title" content-desc="Greeting" bounds="[10,20][110,60]" displayed="true" enabled="true" />
    <android.widget.EditText text="Search here" hint="Search here" resource-id="com.example:id/search" bounds="[0,100][500,160]" displayed="true" enabled="true" />
    <android.widget.EditText text="typed value" hint="Search here" resource-id="com.example:id/query" bounds="[0,200][500,260]" displayed="true" enabled="true" focused="true" />
    <android.widget.Switch text="Wifi" resource-id="com.example:id/wifi" bounds="[0,300][500,360]" displayed="true" enabled="true" checked="true" />
    <android.widget.Button text="Disabled" bounds="[0,400][500,460]" displayed="false" enabled="false" />
  </android.widget.FrameLayout>
</hierarchy>`;

const IOS = `<?xml version="1.0" encoding="UTF-8"?>
<AppiumAUT>
  <XCUIElementTypeApplication type="XCUIElementTypeApplication" name="Playground" label="Playground" enabled="true" visible="true" x="0" y="0" width="390" height="844">
    <XCUIElementTypeStaticText type="XCUIElementTypeStaticText" value="Hello &amp; welcome" name="title" label="Hello &amp; welcome" enabled="true" visible="true" x="10" y="20" width="100" height="40"/>
    <XCUIElementTypeTextField type="XCUIElementTypeTextField" value="Enter name" name="name_field" label="Enter name" enabled="true" visible="true" x="0" y="100" width="300" height="40"/>
    <XCUIElementTypeTextField type="XCUIElementTypeTextField" value="Aman" placeholderValue="Enter name" name="filled_field" enabled="true" visible="true" hasFocus="true" x="0" y="150" width="300" height="40"/>
    <XCUIElementTypeSwitch type="XCUIElementTypeSwitch" value="1" name="toggle" label="Toggle switch" enabled="true" visible="true" x="16" y="200" width="60" height="30"/>
    <XCUIElementTypeButton type="XCUIElementTypeButton" name="disabled_button" label="Disabled" enabled="false" visible="true" x="0" y="250" width="300" height="40"/>
  </XCUIElementTypeApplication>
</AppiumAUT>`;

const flatten = (nodes) => nodes.flatMap((n) => [n, ...flatten(n.children)]);
const byId = (nodes, id) => flatten(nodes).find((n) => n.identifier === id);

test('android: hierarchy wrapper is hoisted away', () => {
  const roots = parseSourceXml(ANDROID, 'android');
  assert.equal(roots.length, 1);
  assert.equal(roots[0].type, 'android.widget.FrameLayout');
  assert.equal(roots[0].children.length, 5);
});

test('android: bounds, label, resourceId and state flags', () => {
  const node = byId(parseSourceXml(ANDROID, 'android'), 'com.example:id/title');
  assert.deepEqual(node.bounds, { x: 10, y: 20, width: 100, height: 40 });
  assert.equal(node.text, 'Welcome');
  assert.equal(node.label, 'Greeting');
  assert.equal(node.resourceId, 'com.example:id/title');
  assert.equal(node.isVisible, true);
  assert.equal(node.isEnabled, true);
});

test('android: an empty field reporting its hint as text has no value', () => {
  const empty = byId(parseSourceXml(ANDROID, 'android'), 'com.example:id/search');
  assert.equal(empty.value, undefined);
  assert.equal(empty.placeholder, 'Search here');

  const filled = byId(parseSourceXml(ANDROID, 'android'), 'com.example:id/query');
  assert.equal(filled.value, 'typed value');
  assert.equal(filled.isFocused, true);
});

test('android: checked and disabled state', () => {
  const roots = parseSourceXml(ANDROID, 'android');
  assert.equal(byId(roots, 'com.example:id/wifi').isChecked, true);
  const disabled = flatten(roots).find((n) => n.text === 'Disabled');
  assert.equal(disabled.isEnabled, false);
  assert.equal(disabled.isVisible, false);
});

test('ios: AppiumAUT is hoisted but the application element is kept', () => {
  const roots = parseSourceXml(IOS, 'ios');
  assert.equal(roots.length, 1);
  assert.equal(roots[0].type, 'XCUIElementTypeApplication');
  assert.deepEqual(roots[0].bounds, { x: 0, y: 0, width: 390, height: 844 });
});

test('ios: entities decode and label mirrors into text', () => {
  const node = byId(parseSourceXml(IOS, 'ios'), 'title');
  assert.equal(node.label, 'Hello & welcome');
  assert.equal(node.text, 'Hello & welcome');
});

test('ios: a value echoing the placeholder is not field content', () => {
  const empty = byId(parseSourceXml(IOS, 'ios'), 'name_field');
  assert.equal(empty.value, undefined);
  assert.equal(empty.placeholder, 'Enter name');

  const filled = byId(parseSourceXml(IOS, 'ios'), 'filled_field');
  assert.equal(filled.value, 'Aman');
  assert.equal(filled.placeholder, 'Enter name');
  assert.equal(filled.isFocused, true);
});

test('ios: switch checked state is derived from value, which mobilecli does not do', () => {
  const toggle = byId(parseSourceXml(IOS, 'ios'), 'toggle');
  assert.equal(toggle.isChecked, true);
  assert.equal(byId(parseSourceXml(IOS, 'ios'), 'disabled_button').isEnabled, false);
});

test('self-closing and nested tags keep tree shape', () => {
  const roots = parseSourceXml(IOS, 'ios');
  assert.equal(flatten(roots).length, 6);
});
