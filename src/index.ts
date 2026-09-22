import { TestMuDriver } from './driver.js';
import type { TestMuDriverOptions } from './types.js';

export { TestMuDriver, DEFAULT_HUB_URL } from './driver.js';
export { TestMuObserver } from './observer.js';
export { parseSourceXml } from './parse-source.js';
export { cropPng } from './png-crop.js';
export { TestMuDriverError, WebDriverError } from './errors.js';
export type { TestMuDriverOptions, NetworkProfile, NetworkThrottle, SnapshotTuning } from './types.js';

/**
 * Config-file spelling of `new TestMuDriver(options)`:
 *
 *   import { defineConfig } from 'mobilewright';
 *   import { testMuDriver } from '@testmuai/mobilewright';
 *
 *   export default defineConfig({
 *     bundleId: 'com.example.app',
 *     driver: testMuDriver({ app: 'lt://APP_ID' }),
 *     projects: [{ name: 'ios', use: { platform: 'ios', deviceType: 'real' } }],
 *   });
 */
export function testMuDriver(options: TestMuDriverOptions = {}): TestMuDriver {
  return new TestMuDriver(options);
}
