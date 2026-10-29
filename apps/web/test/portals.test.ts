// Run: npm test -w apps/web   (node:test via tsx, no extra dependencies)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { portalAccess } from '../src/lib/portalAccess';
import {
  STATION_QUICK_STARTS,
  SECTION_PERMISSION_KEYS,
  portalSections,
  resolvePortalCapabilities,
  sharedDeviceRisks,
} from '../src/lib/portalCapabilities';

const portal = { id: 'p1', status: 'active', force_pw_change: false };

test('a station login opens only its own portal', () => {
  assert.equal(portalAccess({ kind: 'portal', portal_id: 'p1', permissions: ['orders.view'] }, portal).allowed, true);
  assert.equal(portalAccess({ kind: 'portal', portal_id: 'p2', permissions: ['orders.view'] }, portal).allowed, false);
  // Even with Portal Management, another station's portal stays closed.
  assert.equal(portalAccess({ kind: 'portal', portal_id: 'p2', permissions: ['portals.view', 'portals.update'] }, portal).allowed, false);
  assert.equal(portalAccess({ kind: 'portal', portal_id: 'p2', permissions: ['*'] }, portal).allowed, false);
});

test('staff logins with portals.view preview any portal; others cannot', () => {
  assert.equal(portalAccess({ kind: 'staff', permissions: ['*'] }, portal).allowed, true);
  assert.equal(portalAccess({ permissions: ['portals.view'] }, portal).allowed, true);
  assert.equal(portalAccess({ kind: 'staff', permissions: ['orders.view'] }, portal).allowed, false);
  assert.equal(portalAccess({}, portal).allowed, false);
});

test('a disabled portal is closed to its login but previewable; first sign-in forces a password', () => {
  const disabled = { ...portal, status: 'disabled' };
  assert.equal(portalAccess({ kind: 'portal', portal_id: 'p1' }, disabled).allowed, false);
  assert.equal(portalAccess({ kind: 'staff', permissions: ['*'] }, disabled).allowed, true);
  const fresh = { ...portal, force_pw_change: true };
  assert.equal(portalAccess({ kind: 'portal', portal_id: 'p1' }, fresh).mustSetPassword, true);
  assert.equal(portalAccess({ kind: 'staff', permissions: ['*'] }, fresh).mustSetPassword, false);
});

test('station quick-starts only use real portal keys and open the expected sections', () => {
  const known = new Set(Object.values(SECTION_PERMISSION_KEYS).flat());
  for (const q of STATION_QUICK_STARTS) for (const k of q.permissions) assert.ok(known.has(k), `${q.id}: ${k} is not a portal key`);
  const sectionsOf = (id: string) => portalSections(resolvePortalCapabilities(STATION_QUICK_STARTS.find((q) => q.id === id)!.permissions)).map((s) => s.id);
  assert.deepEqual(sectionsOf('kitchen'), ['kitchen']);
  assert.deepEqual(sectionsOf('attendance'), ['attendance']);
  assert.ok(sectionsOf('counter').includes('cashier') && sectionsOf('counter').includes('operations'));
  // No quick-start hands out owner-level keys.
  for (const q of STATION_QUICK_STARTS) assert.deepEqual(sharedDeviceRisks(q.permissions), [], q.id);
});

test('owner-level keys are flagged for shared devices', () => {
  assert.deepEqual(sharedDeviceRisks(['orders.view', 'settings.update', 'portals.create']), ['portals.create', 'settings.update']);
  assert.equal(sharedDeviceRisks(['*']).length, 8);
  assert.deepEqual(sharedDeviceRisks(['kitchen.view']), []);
});
