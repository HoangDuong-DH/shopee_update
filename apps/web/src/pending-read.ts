/** Share concurrent identical reads only; a later refresh always reads the server again. */
export function pendingRead<T>(pending:Map<string,Promise<T>>,key:string,read:()=>Promise<T>):Promise<T> {
  const existing=pending.get(key);
  if(existing) return existing;
  const request=Promise.resolve().then(read).finally(()=>{if(pending.get(key)===request)pending.delete(key);});
  pending.set(key,request);
  return request;
}
