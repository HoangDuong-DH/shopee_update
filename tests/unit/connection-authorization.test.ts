import { describe, it, expect } from 'vitest';
import { validAuthorizationAttempt, authorizationExpiry } from '../../apps/web/src/connection-authorization.js';
const scope={partnerId:'2010476',shopId:'1340479212'};
const callback='http://127.0.0.1:4430/v1/connections/production-pilot/callback';
const attempt={...scope,attemptId:'11111111-2222-4333-8444-555555555555',authorizationUrl:'https://open.shopee.com/auth?partner_id=2010476',callbackUrl:callback,expiresAt:'2030-01-01T00:00:00Z'};
describe('pending authorization stays on its shop and installation',()=>{
  it('restores a valid attempt for a configured runtime port',()=>expect(validAuthorizationAttempt(attempt,scope,callback,0)).toBe(true));
  it('does not use a different shop, callback or unknown runtime as a fallback',()=>{
    expect(validAuthorizationAttempt(attempt,{...scope,shopId:'1'},callback,0)).toBe(false);
    expect(validAuthorizationAttempt(attempt,scope,callback.replace('4430','4310'),0)).toBe(false);
    expect(validAuthorizationAttempt(attempt,scope,undefined,0)).toBe(false);
  });
  it('rejects expired and spoofed URLs even when IDs match',()=>{
    expect(validAuthorizationAttempt({...attempt,expiresAt:0},scope,callback,1)).toBe(false);
    expect(validAuthorizationAttempt({...attempt,authorizationUrl:'https://open.shopee.com.evil.test/auth?partner_id=2010476'},scope,callback,0)).toBe(false);
    expect(validAuthorizationAttempt({...attempt,callbackUrl:callback+'?redirect=other'},scope,callback+'?redirect=other',0)).toBe(false);
  });
  it('understands epoch seconds, milliseconds and ISO without guessing a date',()=>{
    expect(authorizationExpiry(1_900_000_000)).toBe(1_900_000_000_000);
    expect(authorizationExpiry(1_900_000_000_000)).toBe(1_900_000_000_000);
    expect(Number.isFinite(authorizationExpiry('2030-01-01T00:00:00Z'))).toBe(true);
  });
});
