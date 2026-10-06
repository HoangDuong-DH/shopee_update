import { Controller, Get, Module, RequestMethod, type MiddlewareConsumer } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { connect } from 'node:net';
import { expect, it } from 'vitest';
class ProtectedController { read() { return 'PROTECTED_HANDLER'; } }
Controller('guarded')(ProtectedController);
Get()(ProtectedController.prototype,'read',Object.getOwnPropertyDescriptor(ProtectedController.prototype,'read')!);
class ProtectedModule {
 configure(consumer:MiddlewareConsumer) {
  consumer.apply((_request:unknown,response:{end:(body:string)=>void})=>response.end('BLOCKED_BY_MIDDLEWARE'))
   .forRoutes({path:'guarded',method:RequestMethod.GET});
 }
}
Module({controllers:[ProtectedController]})(ProtectedModule);
const rawRequest=(port:number,target:string)=>new Promise<string>((resolve,reject)=>{
 const socket=connect(port,'127.0.0.1');let response='';
 socket.setTimeout(3000,()=>socket.destroy(Error('FIXTURE_HTTP_TIMEOUT')));
 socket.once('connect',()=>socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`));
 socket.on('data',bytes=>{response+=bytes.toString();if(response.length>16384)socket.destroy(Error('FIXTURE_HTTP_RESPONSE_LIMIT'));});
 socket.once('error',reject);socket.once('end',()=>resolve(response));
});
it('path middleware protects both origin-form and absolute-form HTTP targets',async()=>{
 const app=await NestFactory.create(ProtectedModule,new FastifyAdapter(),{logger:false});
 try {await app.listen(0,'127.0.0.1');const port=Number(new URL(await app.getUrl()).port);
  for(const target of ['/guarded',`http://127.0.0.1:${port}/guarded`]){
   const result=await rawRequest(port,target);
   expect(result).toContain('BLOCKED_BY_MIDDLEWARE');expect(result).not.toContain('PROTECTED_HANDLER');
  }
 }finally{await app.close();}
},10000);
