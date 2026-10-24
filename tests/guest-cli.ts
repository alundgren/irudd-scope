// A local CLI stand-in keeps standard tests independent of public relay service.
export const guestCli = String.raw`
const fs = require('node:fs');
const net = require('node:net');
const crypto = require('node:crypto');
const args = process.argv.slice(2);
const keyPath = args.find(a => a.startsWith('--key='))?.slice(6);
const events = process.env.SCOPE_GUEST_FIXTURE_EVENTS;
function record(kind,port) { fs.appendFileSync(events, JSON.stringify({kind,pid:process.pid,port})+'\n'); }
function tunnel(socket,port,observe=false) {
 if(observe) {
  let header='';
  const inspect=chunk=>{
   header+=chunk.toString();
   if(header.includes('\r\n')) {
    const path=header.split(' ')[1];
    if(['/guest/challenge','/guest/hello','/guest/identity'].includes(path))record(path,port);
    socket.removeListener('data',inspect);
   }
  };
  socket.on('data',inspect);
 }
 const routes=process.env.SCOPE_GUEST_FIXTURE_ROUTES;
 const target=observe && routes ? JSON.parse(fs.readFileSync(routes,'utf8'))[port]??port : port;
 const remote=net.connect(target,'127.0.0.1');
 socket.on('error',()=>remote.destroy());remote.on('error',()=>socket.destroy());
 socket.pipe(remote);remote.pipe(socket);
}
if (args[0]==='genkey') {
 fs.writeFileSync(keyPath,JSON.stringify({Private:crypto.randomBytes(32).toString('hex')}));
} else if (args.includes('serve')) {
 const port=Number(args.at(-1));
 const key=keyPath==='new' ? crypto.randomBytes(32) : fs.readFileSync(keyPath);
 const address='tc'+crypto.createHash('sha256').update(key).digest('hex');
 record('serve',port);process.stdout.write(JSON.stringify({listenAddr:address})+'\n');setInterval(()=>{},1000);
} else if (args.includes('forward')) {
 const port=Number(args.at(-1).split(':')[1]);
 net.createServer(socket=>tunnel(socket,port)).listen(0,'127.0.0.1',function(){
 record('forward',this.address().port);process.stderr.write('# forwarding 127.0.0.1:'+this.address().port+' -> remote localhost:'+port+'\n');
 });
} else if (args.includes('socks')) {
 net.createServer(socket=>{
  let phase=0,buffer=Buffer.alloc(0);
  const receive=chunk=>{
   buffer=Buffer.concat([buffer,chunk]);
   if(phase===0 && buffer.length>=3){buffer=buffer.subarray(3);phase=1;socket.write(Buffer.from([5,0]));}
   if(phase===1 && buffer.length>=5 && buffer.length>=7+buffer[4]){
    const end=7+buffer[4],port=buffer.readUInt16BE(end-2);
    socket.removeListener('data',receive);socket.write(Buffer.from([5,0,0,1,127,0,0,1,0,0]));
    if(buffer.length>end)socket.unshift(buffer.subarray(end));tunnel(socket,port,true);
   }
  };
  socket.on('data',receive);socket.on('error',()=>{});
 }).listen(0,'127.0.0.1',function(){record('socks',this.address().port);process.stderr.write('SOCKS running at socks5h://127.0.0.1:'+this.address().port+'\n');});
} else process.exit(2);
`;
