import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyMaintenanceChange, canActivateUpdate, requireVerifiedBackup, shouldRollback } from '../../master_brain/maintenance/self-maintenance-policy.mjs';

test('unknown compatibility or verification never auto-applies', () => {
  assert.equal(classifyMaintenanceChange({compatibility:'UNKNOWN',verification:'PASS'}).action,'HOLD');
  assert.equal(classifyMaintenanceChange({compatibility:'COMPATIBLE',verification:'UNKNOWN'}).action,'HOLD');
});

test('pre-release channels cannot auto-activate', () => {
  assert.equal(classifyMaintenanceChange({channel:'beta',compatibility:'COMPATIBLE',verification:'PASS'}).action,'HOLD');
  assert.equal(classifyMaintenanceChange({channel:'dev',compatibility:'COMPATIBLE',verification:'PASS'}).action,'HOLD');
});

test('governance, permission, and irreversible changes require approval', () => {
  for (const change of [{governance_impact:true},{permission_impact:true},{irreversible:true}])
    assert.equal(classifyMaintenanceChange({...change,compatibility:'COMPATIBLE',verification:'PASS'}).action,'REQUIRE_APPROVAL');
});

test('new capabilities are staged, not silently activated', () => {
  const r=classifyMaintenanceChange({capability_change:true,compatibility:'COMPATIBLE',verification:'PASS'});
  assert.equal(r.action,'AUTO_STAGE');
  assert.equal(canActivateUpdate({capability_change:true,compatibility:'COMPATIBLE',verification:'PASS'}),false);
});

test('verified reversible stable maintenance may auto-apply', () => {
  assert.equal(canActivateUpdate({channel:'stable',compatibility:'COMPATIBLE',verification:'PASS',reversible:true}),true);
});

test('security maintenance still requires reversibility and verification', () => {
  assert.equal(canActivateUpdate({security_critical:true,compatibility:'COMPATIBLE',verification:'PASS',reversible:true}),true);
  assert.equal(canActivateUpdate({security_critical:true,compatibility:'COMPATIBLE',verification:'PASS',reversible:false}),false);
});

test('update activation requires a verified backup', () => {
  assert.equal(requireVerifiedBackup({backup_verified:false}),false);
  assert.equal(requireVerifiedBackup({backup_verified:true}),true);
});

test('failed health or verification triggers rollback decision', () => {
  assert.equal(shouldRollback({health:'FAIL',verification:'PASS'}),true);
  assert.equal(shouldRollback({health:'PASS',verification:'FAIL'}),true);
  assert.equal(shouldRollback({health:'PASS',verification:'PASS',migration:'PASS'}),false);
});
