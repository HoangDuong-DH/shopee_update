import { createHash, randomUUID } from 'node:crypto';
import { canonicalJson } from '@shopee/domain';
import { expect, it } from 'vitest';
import { intendedHiddenCapabilityProbe, unknownProductionCapabilityEvidence } from '../../apps/api/src/production-batch-capability.js';
import { withProductionScope } from '../../apps/api/src/production-scope.js';
const base={hidden:true,batchId:randomUUID(),manifestSha256:'a'.repeat(64),authorizationReference:'Operator selected exact hidden listing',source:{sourceIdentity:'intent-a',sourceRevision:1,document:{publication:'unlisted',description:[{type:'text',text:'Sourced content'}]} as any},evidence:unknownProductionCapabilityEvidence(1,'fixture')};
it('binds the permission to scope, manifest, intent, source revision and exact content; known feature subsets keep the same permission',()=>{
  const original=intendedHiddenCapabilityProbe(base)!;
  for(const patch of [{manifestSha256:'b'.repeat(64)},{authorizationReference:'different intent'},{source:{...base.source,sourceRevision:2}},{source:{...base.source,document:{...base.source.document,title:'changed'}}}])expect(intendedHiddenCapabilityProbe({...base,...patch})!.authorizationReference).not.toBe(original.authorizationReference);
  expect(withProductionScope({environment:'production',partnerId:'2010476',shopId:'1126307464'},()=>intendedHiddenCapabilityProbe(base))!.authorizationReference).not.toBe(original.authorizationReference);
  expect(()=>intendedHiddenCapabilityProbe({...base,hidden:false})).toThrow('PROBE_FORBIDDEN');
  expect(()=>intendedHiddenCapabilityProbe({...base,source:{...base.source,document:{...base.source.document,publication:'normal'}}})).toThrow('PROBE_FORBIDDEN');
  const extended={...base,source:{...base.source,document:{...base.source.document,description:[{type:'image',image:{}}]}}};
  const all=intendedHiddenCapabilityProbe(extended)!;
  const evidence=structuredClone(base.evidence);evidence.gallery34.state='supported';evidence.gallery34.verifiedOperationId=randomUUID();
  const partial=intendedHiddenCapabilityProbe({...extended,evidence})!;
  expect(partial.capabilities).toEqual(['extendedDescription']);expect(partial.authorizationReference).toBe(all.authorizationReference);
});
