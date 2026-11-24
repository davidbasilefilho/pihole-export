import { Effect } from "effect";
import { fetchAllQueries } from "../src/lib/api";
import { exportNative } from "../src/lib/backend";
const [url, mode, path] = process.argv.slice(2);
const connection = { baseUrl: url!, session: {valid:true,sid:null,csrf:null,validity:1800,totp:false,message:null}, ownedSession:false };
const spec = {from:1788220800,until:1788307200,disk:true,domain:"synthetic.example",clientIp:"",clientName:"",upstream:"",type:"",status:"",reply:"",dnssec:""};
const start = performance.now();
const result = await Effect.runPromise(mode === "query" ? fetchAllQueries(connection,spec).pipe(Effect.map(rows=>rows.length)) : exportNative(connection,spec,path!,"jsonl").pipe(Effect.map(r=>r.count)));
console.log(JSON.stringify({mode, count:result, milliseconds:performance.now()-start}));
