import test from 'node:test';
import assert from 'node:assert/strict';
import {LIVE_EVIDENCE_REFRESH,getLiveEvidenceRefresh,assertNoAutomaticPromotion} from '../../master_brain/verification/harness/threshold-live-evidence.mjs';

test('live threshold evidence catalog is dated and contains current candidate families',()=>{
  assert.equal(LIVE_EVIDENCE_REFRESH.as_of,'2026-10-06');
  const ids=LIVE_EVIDENCE_REFRESH.candidates.map(c=>c.id);
  for (const id of ['FROST','Mask-FROST','FaFROST','TSitH','Efficient-Threshold-ML-DSA','Quorus','TALUS','FROST2+']) assert.ok(ids.includes(id));
});

test('live evidence refresh never auto-promotes research candidates',()=>{
  assert.equal(assertNoAutomaticPromotion(),true);
  assert.ok(getLiveEvidenceRefresh().candidates.every(c=>c.status!=='QUALIFIED'));
});

test('artifact revision state forces requalification',()=>{
  const talus=getLiveEvidenceRefresh().candidates.find(c=>c.id==='TALUS');
  assert.equal(talus.status,'HOLD');
  assert.equal(talus.requires_requalification,true);
});
