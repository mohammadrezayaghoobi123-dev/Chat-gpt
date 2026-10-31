const LIVE_EVIDENCE_REFRESH = Object.freeze({
  as_of: '2026-10-06',
  policy: 'RESEARCH_EVIDENCE_ONLY',
  candidates: Object.freeze([
    {id:'FROST',track:'Schnorr/EdDSA',status:'HOLD',evidence_class:'STANDARDIZED_REFERENCE',requires_requalification:true},
    {id:'Mask-FROST',track:'Schnorr/EdDSA',status:'HOLD',evidence_class:'RESEARCH',requires_requalification:true},
    {id:'FaFROST',track:'Schnorr/EdDSA',status:'HOLD',evidence_class:'RESEARCH',requires_requalification:true},
    {id:'TSitH',track:'MPC-in-the-Head/PQC',status:'HOLD',evidence_class:'NIST_PREVIEW_RESEARCH',requires_requalification:true},
    {id:'Efficient-Threshold-ML-DSA',track:'ML-DSA/PQC',status:'HOLD',evidence_class:'PEER_REVIEWED_RESEARCH',requires_requalification:true},
    {id:'Quorus',track:'ML-DSA/MPC/PQC',status:'HOLD',evidence_class:'PEER_REVIEWED_RESEARCH',requires_requalification:true},
    {id:'TALUS',track:'ML-DSA/PQC',status:'HOLD',evidence_class:'NIST_PREVIEW_WITH_REVISED_ARTIFACT',requires_requalification:true},
    {id:'FROST2+',track:'Schnorr',status:'HOLD',evidence_class:'RECENT_RESEARCH',requires_requalification:true},
    {id:'Threshold-Authorization-Without-TSS',track:'Signature-Agnostic-MPC-Custody',status:'HOLD',evidence_class:'RECENT_RESEARCH',requires_requalification:true}
  ])
});

function getLiveEvidenceRefresh(){ return LIVE_EVIDENCE_REFRESH; }

function assertNoAutomaticPromotion(){
  for (const c of LIVE_EVIDENCE_REFRESH.candidates) {
    if (c.status === 'QUALIFIED') throw new Error('LIVE_EVIDENCE_CATALOG_MUST_NOT_AUTO_PROMOTE');
  }
  return true;
}

export {LIVE_EVIDENCE_REFRESH,getLiveEvidenceRefresh,assertNoAutomaticPromotion};
