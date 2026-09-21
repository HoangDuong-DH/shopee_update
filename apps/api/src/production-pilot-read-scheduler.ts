import type { ProductionPilotTransport } from '../../../packages/shopee/src/production-pilot-transport.js';
const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
/** Internal conservative start budget, not a declaration of Shopee quota. One process shares it. */
export class ProductionPilotReadPacer {
  private readonly interval:number;
  private readonly now:()=>number;
  private lastStart:number|undefined;
  private tail:Promise<void>=Promise.resolve();
  constructor(options:{minimumIntervalMs?:number;now?:()=>number}={}) {
    this.interval=options.minimumIntervalMs??500;
    if(!Number.isSafeInteger(this.interval)||this.interval<500||this.interval>30000)throw Error('PRODUCTION_READ_PACING_INVALID');
    this.now=options.now??Date.now;
  }
  async acquire(pause:(ms:number)=>Promise<void>=sleep) {
    const next=this.tail.then(async()=>{
      const wait=this.lastStart===undefined?0:Math.max(0,this.lastStart+this.interval-this.now());
      if(wait)await pause(wait);
      this.lastStart=this.now();
    });
    this.tail=next.catch(()=>{});
    await next;
  }
}
const sharedPacer=new ProductionPilotReadPacer();

/** Only GETs are exposed. Retain each response before a bounded retry of an explicit rate limit. */
export async function readProductionPilotWithBackoff(
  client: Pick<ProductionPilotTransport, 'read'>,
  path: string,
  query: Record<string, string>,
  record: (outcome: Awaited<ReturnType<ProductionPilotTransport['read']>>, attempt: number) => Promise<void>,
  pause: (milliseconds: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  pacer:ProductionPilotReadPacer=sharedPacer,
) {
  const waits = [0, 1000, 3000, 7000];
  for (let attempt = 0; attempt < waits.length; attempt++) {
    if(waits[attempt])await pause(waits[attempt]!);
    await pacer.acquire(pause);
    const outcome = await client.read(path, query);
    await record(outcome, attempt);
    const rateLimited = outcome.kind === 'rejected' && outcome.code === 'error_rate_limit' &&
      outcome.envelope?.error === 'error_rate_limit' && !!outcome.requestId;
    if (!rateLimited || attempt === waits.length - 1) return outcome;
  }
  throw new Error('PRODUCTION_PILOT_READ_SCHEDULE_EXHAUSTED');
}
