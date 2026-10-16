// Minimal Chrome DevTools pipe transport; no npm/browser download or substitute.
import assert from 'node:assert/strict';
export class CDP {
  constructor(input, output, events = []) {
    this.input=input;this.pending=new Map();this.next=0;this.buffer=Buffer.alloc(0);this.events=events;
    output.on('data',chunk=>{
      this.buffer=Buffer.concat([this.buffer,chunk]);
      assert.ok(this.buffer.length<32*1024*1024,'CDP frame bound');
      let end;
      while((end=this.buffer.indexOf(0))>=0) {
        const data=JSON.parse(this.buffer.subarray(0,end).toString());this.buffer=this.buffer.subarray(end+1);
        if(data.id) {const p=this.pending.get(data.id);if(p){this.pending.delete(data.id);clearTimeout(p.timer);data.error?p.reject(new Error(JSON.stringify(data.error))):p.resolve(data.result);}}
        else this.events.push(data);
      }
    });
    const fail=error=>{for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}this.pending.clear();};
    output.on('close',()=>fail(new Error('Chrome pipe closed')));
    output.on('error',fail);input.on('error',fail);
  }
  call(method,params={},sessionId) {
    const id=++this.next;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`CDP timeout: ${method}`));},10000);
      this.pending.set(id,{resolve,reject,timer});
      this.input.write(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})})+'\0');
    });
  }
  page(session) {
    return {
      call:(method,params)=>this.call(method,params,session),
      evaluate:async expression=>{
        const data=await this.call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},session);
        assert.equal(data.exceptionDetails,undefined,JSON.stringify(data.exceptionDetails));return data.result.value;
      }
    };
  }
}
