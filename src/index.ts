import { LambdaTestDriver } from './driver.js';
import type { LambdaTestDriverOptions } from './types.js';

export { LambdaTestDriver, DEFAULT_HUB_URL } from './driver.js';
export { LambdaTestObserver } from './observer.js';
export { parseSourceXml } from './parse-source.js';
export { cropPng } from './png-crop.js';
export { LambdaTestDriverError, WebDriverError } from './errors.js';
export type { LambdaTestDriverOptions, NetworkProfile, NetworkThrottle, SnapshotTuning } from './types.js';

/**
 * Config-file spelling of `new LambdaTestDriver(options)`:
 *
 *   import { defineConfig } from 'mobilewright';
 *   import { lambdaTestDriver } from '@lambdatest/mobilewright';
 *
 *   export default defineConfig({
 *     bundleId: 'com.example.app',
 *     driver: lambdaTestDriver({ app: 'lt://APP_ID' }),
 *     projects: [{ name: 'ios', use: { platform: 'ios', deviceType: 'real' } }],
 *   });
 */
export function lambdaTestDriver(options: LambdaTestDriverOptions = {}): LambdaTestDriver {
  return new LambdaTestDriver(options);
}
