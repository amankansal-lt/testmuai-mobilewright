import test from 'node:test';
import assert from 'node:assert/strict';
import { queryAll, bareTypeName, ROLE_TYPE_MAP } from '@mobilewright/core';
import { parseSourceXml } from '../dist/parse-source.js';

// Guards the seam that typechecking cannot see: upstream's query engine has to
// understand the ViewNodes OUR parser produces from Appium page source.
// Upstream's role map is written against mobilecli's type vocabulary, so a new
// role or a change to bareTypeName can silently stop matching Appium's raw
// types (XCUIElementTypeSlider vs mobilecli's Slider) with no interface change
// and no compile error. 0.0.56 shipped exactly that shape of change.

const IOS = `<AppiumAUT><XCUIElementTypeApplication type="XCUIElementTypeApplication" name="App"
  enabled="true" visible="true" x="0" y="0" width="390" height="844">
  <XCUIElementTypeButton type="XCUIElementTypeButton" name="go" label="Go" enabled="true" visible="true" x="0" y="0" width="80" height="40"/>
  <XCUIElementTypeSlider type="XCUIElementTypeSlider" name="vol" value="50%" enabled="true" visible="true" x="0" y="50" width="200" height="30"/>
  <XCUIElementTypeSwitch type="XCUIElementTypeSwitch" name="wifi" value="1" enabled="true" visible="true" x="0" y="90" width="60" height="30"/>
  <XCUIElementTypeTextField type="XCUIElementTypeTextField" name="email" value="a@b.c" enabled="true" visible="true" x="0" y="130" width="200" height="40"/>
  <XCUIElementTypeStaticText type="XCUIElementTypeStaticText" name="hello" label="Hello" enabled="true" visible="true" x="0" y="180" width="100" height="20"/>
  <XCUIElementTypeNavigationBar type="XCUIElementTypeNavigationBar" name="Main" enabled="true" visible="true" x="0" y="210" width="390" height="44"/>
  <XCUIElementTypeProgressIndicator type="XCUIElementTypeProgressIndicator" name="busy" enabled="true" visible="true" x="0" y="260" width="100" height="10"/>
</XCUIElementTypeApplication></AppiumAUT>`;

const ANDROID = `<hierarchy rotation="0">
  <android.widget.Button text="Go" resource-id="a:id/go" bounds="[0,0][80,40]" displayed="true" enabled="true"/>
  <android.widget.SeekBar resource-id="a:id/vol" bounds="[0,50][200,80]" displayed="true" enabled="true"/>
  <android.widget.Switch resource-id="a:id/wifi" bounds="[0,90][60,120]" displayed="true" enabled="true" checked="true"/>
  <android.widget.EditText text="a@b.c" resource-id="a:id/email" bounds="[0,130][200,170]" displayed="true" enabled="true"/>
  <android.widget.TextView text="Hello" resource-id="a:id/hello" bounds="[0,180][100,200]" displayed="true" enabled="true"/>
</hierarchy>`;

const roleMatches = (xml, platform, role) =>
  queryAll(parseSourceXml(xml, platform), { kind: 'role', value: role });

test('upstream getByRole matches our iOS ViewNodes', () => {
  for (const role of ['button', 'slider', 'switch', 'textfield', 'text']) {
    assert.ok(roleMatches(IOS, 'ios', role).length > 0, `no iOS match for role "${role}"`);
  }
});

test('upstream getByRole matches our Android ViewNodes', () => {
  for (const role of ['button', 'switch', 'textfield', 'text']) {
    assert.ok(roleMatches(ANDROID, 'android', role).length > 0, `no Android match for role "${role}"`);
  }
});

test('roles added in 0.0.60 match Appium types, not just mobilecli ones', () => {
  // These arrived with 0.0.60. Upstream shipped them for mobilecli's iOS dump;
  // this asserts Appium's raw types satisfy the same mapping.
  assert.ok(roleMatches(IOS, 'ios', 'progressbar').length > 0, 'XCUIElementTypeProgressIndicator should be a progressbar');
  assert.ok(roleMatches(IOS, 'ios', 'header').length > 0, 'XCUIElementTypeNavigationBar should be a header');
});

test('upstream bareTypeName normalizes the raw types we emit', () => {
  // Appium keeps the XCUIElementType prefix and Android the package path;
  // mobilecli strips both. Upstream normalizes for role resolution — if that
  // ever stops, every getByRole against this driver breaks at runtime.
  assert.equal(bareTypeName('XCUIElementTypeButton'), 'button');
  assert.equal(bareTypeName('android.widget.EditText'), 'edittext');
});

test('roles upstream knows about are reported, so new ones are noticed', () => {
  const roles = Object.keys(ROLE_TYPE_MAP);
  // Fails when upstream adds a role, as a prompt to check it against Appium's
  // type vocabulary rather than assuming mobilecli's.
  assert.deepEqual(
    roles.sort(),
    [
      'alert', 'button', 'checkbox', 'combobox', 'header', 'image', 'link',
      'list', 'listitem', 'progressbar', 'radio', 'slider', 'switch', 'tab',
      'text', 'textfield',
    ].sort(),
    `upstream role set changed: ${roles.join(', ')}`,
  );
});
