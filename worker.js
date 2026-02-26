    // ProxyIP Manager v3 - Cloudflare Workers
    // 部署: Workers面板粘贴 → KV绑定变量名KV → Cron触发器: 0 0,6,12,18 * * *
    // KV: config, groups, ips:{groupId}, blacklist, last_result
    const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
    const CHECK_API='https://cf.090227.xyz/check?proxyip=';
    const CHECK_TIMEOUT=10000, BATCH=30, RETRY=1; // Python: 10s超时, 1次重试(共2次尝试)

    function parseCSV(text){
      const lines=text.replace(/^\uFEFF/,'').trim().split('\n').filter(l=>l.trim());
      if(lines.length<2)return[];
      const ips=[];
      for(let i=1;i<lines.length;i++){
        const c=lines[i].split(',');if(c.length<7)continue;
        const ipPort=c[0]?.trim();if(!ipPort||!ipPort.includes(':'))continue;
        const[ip,port]=ipPort.split(':');
        ips.push({ipPort,ip,port:+port,asn:c[1]?.trim()||'',riskLevel:c[2]?.trim()||'',
          riskScore:c[3]?.trim()||'',country:c[5]?.trim()||'',latency:(v=>Number.isNaN(v)?9999:v)(parseInt(c[6])),
          city:c[7]?.trim()||'',org:c[8]?.trim()||'',company:c[9]?.trim()||'',
          colo:c[11]?.trim()||'',status:'unchecked',lastCheck:'',checkLatency:9999});
      }
      return ips;
    }

    // 参照 检测proxyip.py 重写：单次请求带硬超时，干净利落
    async function fetchCheck(ipPort){
      const c=new AbortController();
      const t=setTimeout(()=>c.abort(),CHECK_TIMEOUT);
      try{
        const r=await fetch(CHECK_API+encodeURIComponent(ipPort),{signal:c.signal,headers:{'User-Agent':UA}});
        if(!r.ok){clearTimeout(t);return{ok:false,reason:'http_'+r.status}}
        // 给 r.json() 也加硬超时，防止 body 读取卡死
        const d=await Promise.race([r.json(),new Promise((_,rej)=>setTimeout(()=>rej(new Error('body_timeout')),5000))]);
        clearTimeout(t);
        if(d.success===true||d.success==='true'){
          const lat=parseInt(d.responseTime);
          return{ok:true,latency:Number.isNaN(lat)?9999:lat,colo:d.colo||'UNK'};
        }
        return{ok:false,reason:d.message||d.error||'api_fail'};
      }catch(e){
        clearTimeout(t);
        if(e.name==='AbortError')return{ok:false,reason:'timeout'};
        if(e.message==='body_timeout')return{ok:false,reason:'timeout'};
        return{ok:false,reason:'network_error'};
      }
    }

    // Python: MAX_RETRIES=1 → 最多2次尝试，成功立即返回
    async function checkIP(ipPort){
      let lastReason='unknown';
      for(let i=0;i<=RETRY;i++){
        const r=await fetchCheck(ipPort);
        if(r.ok)return r;
        lastReason=r.reason;
      }
      return{ok:false,reason:lastReason};
    }

    async function batchCheck(list,onProgress){
      const out=[];let valid=0,invalid=0;
      const startTime=Date.now();
      const MAX_TIME=270000; // 4.5分钟总时限
      if(onProgress)await onProgress({phase:'checking',checked:0,total:list.length,valid:0,invalid:0});
      // 第一轮：全量并发检测
      for(let i=0;i<list.length;i+=BATCH){
        if(Date.now()-startTime>MAX_TIME)break;
        const chunk=list.slice(i,i+BATCH);
        const res=await Promise.allSettled(chunk.map(async ip=>{
          const r=await checkIP(ip.ipPort);
          if(r.ok)return{...ip,status:'valid',checkLatency:r.latency,colo:r.colo||ip.colo,failReason:'',lastCheck:new Date().toISOString()};
          return{...ip,status:'invalid',failReason:r.reason||'unknown',lastCheck:new Date().toISOString()};
        }));
        for(const r of res){
          if(r.status!=='fulfilled')continue;
          out.push(r.value);
          r.value.status==='valid'?valid++:invalid++;
        }
        if(onProgress)await onProgress({phase:'checking',checked:out.length,total:list.length,valid,invalid});
      }
      // 第二轮：失效IP并发重测（Python风格：快速过一遍，不拖泥带水）
      const failed=out.filter(i=>i.status==='invalid');
      if(failed.length>0&&Date.now()-startTime<MAX_TIME){
        if(onProgress)await onProgress({phase:'rechecking',checked:out.length,total:list.length,valid,invalid,recheck:0,recheckTotal:failed.length});
        const RECHECK_BATCH=15;
        let recheckDone=0;
        for(let i=0;i<failed.length;i+=RECHECK_BATCH){
          if(Date.now()-startTime>MAX_TIME)break;
          const chunk=failed.slice(i,i+RECHECK_BATCH);
          await Promise.allSettled(chunk.map(async ip=>{
            const r=await fetchCheck(ip.ipPort); // 单次尝试，不重试
            if(r.ok){
              ip.status='valid';ip.checkLatency=r.latency;ip.colo=r.colo||ip.colo;ip.failReason='';ip.lastCheck=new Date().toISOString();
              valid++;invalid--;
            }else{
              ip.failReason=r.reason||ip.failReason;
            }
          }));
          recheckDone+=chunk.length;
          if(onProgress)await onProgress({phase:'rechecking',checked:out.length,total:list.length,valid,invalid,recheck:recheckDone,recheckTotal:failed.length});
        }
      }
      return out;
    }
    async function resolveToCloudflare(g,ips){
      if(!g.cfToken||!g.zoneId||!g.domain)throw new Error('['+g.id+']缺少CF配置');
      const recordType=g.recordType||'TXT';
      const h={'Authorization':'Bearer '+g.cfToken,'Content-Type':'application/json'};
      const base='https://api.cloudflare.com/client/v4/zones/'+g.zoneId+'/dns_records';

      if(recordType==='A'){
        // A记录：为每个IP创建一条A记录
        // 1. 查询所有现有的A记录
        const lr=await(await fetch(base+'?name='+g.domain+'&type=A',{headers:h})).json();
        if(!lr.success)throw new Error('CF查询失败:'+JSON.stringify(lr.errors));
        const existing=lr.result||[];

        // 2. 删除所有现有的A记录
        for(const record of existing){
          await fetch(base+'/'+record.id,{method:'DELETE',headers:h});
        }

        // 3. 为每个IP创建新的A记录（去掉端口）
        for(const ip of ips){
          const ipOnly=ip.ipPort.split(':')[0];
          const body=JSON.stringify({type:'A',name:g.domain,content:ipOnly,ttl:60,proxied:false});
          const res=await(await fetch(base,{method:'POST',headers:h,body})).json();
          if(!res.success)throw new Error('CF写入失败:'+JSON.stringify(res.errors));
        }
      }else{
        // TXT记录：多个IP用逗号分隔
        const lr=await(await fetch(base+'?name='+g.domain+'&type=TXT',{headers:h})).json();
        if(!lr.success)throw new Error('CF查询失败:'+JSON.stringify(lr.errors));
        const ext=lr.result?.[0];
        const content='"'+ips.map(i=>i.ipPort).join(',')+'"';
        const body=JSON.stringify({type:'TXT',name:g.domain,content,ttl:60});
        const res=ext?await(await fetch(base+'/'+ext.id,{method:'PUT',headers:h,body})).json()
          :await(await fetch(base,{method:'POST',headers:h,body})).json();
        if(!res.success)throw new Error('CF写入失败:'+JSON.stringify(res.errors));
      }
      return true;
    }

    async function sendTG(cfg,msg){
      if(!cfg.tgToken||!cfg.tgChatId)return;
      try{await fetch('https://api.telegram.org/bot'+cfg.tgToken+'/sendMessage',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({chat_id:cfg.tgChatId,text:msg,parse_mode:'HTML'})
      })}catch{}
    }

    async function autoCheckAndResolve(env){
      const cfg=JSON.parse(await env.KV.get('config')||'{}');
      const groups=JSON.parse(await env.KV.get('groups')||'[]');
      const bl=new Set(JSON.parse(await env.KV.get('blacklist')||'[]'));
      if(!groups.length)return;
      // 收集所有分组IP(去重，排除回收站中的IP)
      const allMap=new Map();
      for(const g of groups){
        let gips=JSON.parse(await env.KV.get('ips:'+g.id)||'[]');
        const groupTrash=JSON.parse(await env.KV.get('trash:'+g.id)||'[]');
        const trashIPs=new Set(groupTrash.map(t=>t.ipPort));
        let filtered=gips.filter(ip=>!bl.has(ip.ip)&&!trashIPs.has(ip.ipPort));
        if(g.selectedAsns?.length)filtered=filtered.filter(ip=>g.selectedAsns.includes(ip.asn));
        filtered.forEach(ip=>{if(!allMap.has(ip.ipPort))allMap.set(ip.ipPort,ip)});
      }
      const toCheck=[...allMap.values()];
      if(!toCheck.length)return;
      // 写入初始进度
      await env.KV.put('check_progress',JSON.stringify({phase:'checking',checked:0,total:toCheck.length,valid:0,invalid:0,start:new Date().toISOString()}));
      // 全并发检测(BATCH并发，失败重试RETRY次)
      const checked=await batchCheck(toCheck,async(p)=>{
        await env.KV.put('check_progress',JSON.stringify({...p,start:new Date().toISOString()}));
      });
      const resultMap=new Map(checked.map(i=>[i.ipPort,i]));
      const validSet=new Set(checked.filter(i=>i.status==='valid').map(i=>i.ipPort));
      // 收集失效IP到各分组回收站
      const now=new Date().toISOString();
      const invalidIPs=checked.filter(i=>i.status==='invalid');
      for(const g of groups){
        const groupTrash=JSON.parse(await env.KV.get('trash:'+g.id)||'[]');
        const gips=JSON.parse(await env.KV.get('ips:'+g.id)||'[]');
        const groupInvalidIPs=invalidIPs.filter(ip=>gips.some(gip=>gip.ipPort===ip.ipPort));
        groupInvalidIPs.forEach(ip=>{
          groupTrash.push({...ip,deletedAt:now,deletedReason:ip.failReason||'unknown'});
        });
        await env.KV.put('trash:'+g.id,JSON.stringify(groupTrash));
      }
      // 按分组更新，移除失效IP（不再自动解析DNS）
      await env.KV.put('check_progress',JSON.stringify({phase:'updating',checked:checked.length,total:toCheck.length,valid:validSet.size,invalid:checked.length-validSet.size}));
      const gr=[];
      for(const g of groups){
        let gips=JSON.parse(await env.KV.get('ips:'+g.id)||'[]');
        gips=gips.map(ip=>resultMap.get(ip.ipPort)||ip);
        // 移除失效IP
        const validIPs=gips.filter(i=>i.status!=='invalid');
        const removedCount=gips.length-validIPs.length;
        await env.KV.put('ips:'+g.id,JSON.stringify(validIPs));
        let gv=validIPs.filter(i=>i.status==='valid');
        if(g.selectedAsns?.length)gv=gv.filter(i=>g.selectedAsns.includes(i.asn));
        const sorted=[...gv].sort((a,b)=>a.checkLatency-b.checkLatency);
        const topIPs=sorted.slice(0,g.resolveCount||8);
        gr.push({id:g.id,name:g.name,domain:g.domain,count:validIPs.length,removed:removedCount,topIPs:topIPs.map(i=>i.ipPort+'('+i.checkLatency+'ms)')});
      }
      // 统计失效原因
      const failedIPs=checked.filter(i=>i.status==='invalid');
      const reasonMap={};failedIPs.forEach(i=>{const r=i.failReason||'unknown';reasonMap[r]=(reasonMap[r]||0)+1});
      const reasonLabels={timeout:'超时',network_error:'网络错误',api_fail:'API返回失败',unknown:'未知'};
      const reasonStr=Object.entries(reasonMap).map(([k,v])=>(reasonLabels[k]||k)+':'+v).join(' | ');
      const result={time:new Date().toISOString(),total:toCheck.length,checked:checked.length,valid:validSet.size,invalid:checked.length-validSet.size,failReasons:reasonMap,groups:gr};
      await env.KV.put('last_result',JSON.stringify(result));
      await env.KV.put('check_progress',JSON.stringify({phase:'done',checked:checked.length,total:toCheck.length,valid:validSet.size,invalid:checked.length-validSet.size}));
      let tm='<b>🔍 ProxyIP检测报告</b>\n⏰'+result.time+'\n📊 总:'+result.total+' ✅'+result.valid+' ❌'+result.invalid;
      if(reasonStr)tm+='\n📋 失效原因: '+reasonStr;
      for(const g of gr){
        tm+='\n\n<b>📦'+g.name+'</b>→'+g.domain;
        if(g.removed>0)tm+='\n🗑️ 已移除'+g.removed+'个失效IP';
        tm+='\n'+(g.topIPs.length?g.topIPs.map(r=>'  '+r).join('\n'):'  无有效IP');
      }
      await sendTG(cfg,tm);
      return result;
    }

    // 定时FOFA搜索：只保存新IP到列表，不检测
    async function scheduledFofaSearch(env){
      const cfg=JSON.parse(await env.KV.get('config')||'{}');
      if(!cfg.fofaKey)return;
      const groups=JSON.parse(await env.KV.get('groups')||'[]');
      const now=new Date();
      const hour=now.getUTCHours();
      let totalAdded=0;
      for(const g of groups){
        if(!g.fofaQuery||!g.fofaCron)continue;
        const interval=parseInt(g.fofaCron);
        if(!interval||hour%interval!==0)continue;
        try{
          const qbase64=btoa(g.fofaQuery);
          const size=g.fofaSize||10000;
          const url=`https://fofoapi.com/api/v1/search/all?qbase64=${qbase64}&key=${cfg.fofaKey}&size=${size}&fields=ip,port,as_number,as_organization,city,country`;
          const res=await fetch(url);
          const data=await res.json();
          if(!data.results||!data.results.length)continue;
          const newIPs=data.results.map(r=>{
            const[ip,port,asn,org,city,country]=r;
            return{ipPort:`${ip}:${port}`,ip,port:+port,asn:asn||'',org:org||'',city:city||'',country:country||'',
              status:'unchecked',lastCheck:'',checkLatency:9999,colo:'',riskLevel:'',riskScore:'',latency:9999,company:''};
          });
          const old=JSON.parse(await env.KV.get('ips:'+g.id)||'[]');
          const groupTrash=JSON.parse(await env.KV.get('trash:'+g.id)||'[]');
          const existingIPs=new Set(old.map(i=>i.ipPort));
          const trashIPs=new Set(groupTrash.map(t=>t.ipPort));
          const toAdd=newIPs.filter(i=>!existingIPs.has(i.ipPort)&&!trashIPs.has(i.ipPort));
          if(!toAdd.length)continue;
          await env.KV.put('ips:'+g.id,JSON.stringify([...old,...toAdd]));
          totalAdded+=toAdd.length;
          let tgMsg=`<b>⏰ FOFA定时搜索 [${g.name}]</b>\n`;
          tgMsg+=`📊 搜索到: ${data.results.length} | 新增: ${toAdd.length}\n`;
          tgMsg+=`💾 已保存到IP列表，等待下次检测`;
          await sendTG(cfg,tgMsg);
        }catch(e){console.error('FOFA定时搜索失败['+g.id+']:',e)}
      }
    }

    function json(d,s=200){return new Response(JSON.stringify(d),{status:s,headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}})}
    async function handleAPI(path,req,env,ctx){
      if(req.method==='OPTIONS')return new Response(null,{headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'*'}});
      const cfg=JSON.parse(await env.KV.get('config')||'{}');
      if(path==='/api/init')return json({needSetup:!cfg.password});
      if(path==='/api/setup'&&req.method==='POST'){
        if(cfg.password)return json({error:'已初始化'},403);
        const b=await req.json();if(!b.password)return json({error:'需要密码'},400);
        await env.KV.put('config',JSON.stringify({...cfg,...b}));return json({ok:1});
      }
      if(cfg.password&&req.headers.get('X-Auth')!==cfg.password)return json({error:'密码错误'},401);
      if(path==='/api/config'){
        if(req.method==='POST'){const b=await req.json();if(b.password==='')delete b.password;await env.KV.put('config',JSON.stringify({...cfg,...b}));return json({ok:1})}
        const{password,...safe}=cfg;return json(safe);
      }
      if(path==='/api/upload'&&req.method==='POST'){
        const{groupId,csv}=await req.json();if(!groupId)return json({error:'需要分组ID'},400);
        const ni=parseCSV(csv);if(!ni.length)return json({error:'无有效数据'},400);
        const old=JSON.parse(await env.KV.get('ips:'+groupId)||'[]');
        const groupTrash=JSON.parse(await env.KV.get('trash:'+groupId)||'[]');
        const existingIPs=new Set(old.map(i=>i.ipPort));
        const trashIPs=new Set(groupTrash.map(t=>t.ipPort));
        // 过滤：不在现有列表中 且 不在回收站中
        const added=ni.filter(i=>!existingIPs.has(i.ipPort)&&!trashIPs.has(i.ipPort));
        const rejected=ni.filter(i=>trashIPs.has(i.ipPort)).length;
        await env.KV.put('ips:'+groupId,JSON.stringify([...old,...added]));
        return json({ok:1,added:added.length,rejected,total:old.length+added.length});
      }
      if(path==='/api/ips'){
        const groupId=new URL(req.url).searchParams.get('groupId');
        if(!groupId)return json({error:'需要分组ID'},400);
        return json({ips:JSON.parse(await env.KV.get('ips:'+groupId)||'[]')});
      }
      if(path==='/api/delete-ip'&&req.method==='POST'){
        const{groupId,ipPorts}=await req.json();
        let ips=JSON.parse(await env.KV.get('ips:'+groupId)||'[]');
        const s=new Set(ipPorts);ips=ips.filter(i=>!s.has(i.ipPort));
        await env.KV.put('ips:'+groupId,JSON.stringify(ips));return json({ok:1});
      }
      if(path==='/api/asns'){
        const groupId=new URL(req.url).searchParams.get('groupId');
        if(!groupId)return json({error:'需要分组ID'},400);
        const ips=JSON.parse(await env.KV.get('ips:'+groupId)||'[]'),m={};
        ips.forEach(i=>{if(i.asn)m[i.asn]=(m[i.asn]||0)+1});
        return json(Object.entries(m).map(([a,c])=>({asn:a,count:c})).sort((a,b)=>b.count-a.count));
      }
      if(path==='/api/blacklist'){
        if(req.method==='POST'){await env.KV.put('blacklist',JSON.stringify((await req.json()).blacklist||[]));return json({ok:1})}
        return json(JSON.parse(await env.KV.get('blacklist')||'[]'));
      }
      if(path==='/api/groups'){
        if(req.method==='POST'){const g=await req.json();if(!g.id)return json({error:'需要分组ID'},400);let gs=JSON.parse(await env.KV.get('groups')||'[]');const idx=gs.findIndex(x=>x.id===g.id);idx>=0?gs[idx]={...gs[idx],...g}:gs.push(g);await env.KV.put('groups',JSON.stringify(gs));return json({ok:1})}
        return json(JSON.parse(await env.KV.get('groups')||'[]'));
      }
      if(path==='/api/delete-group'&&req.method==='POST'){const{id}=await req.json();let gs=JSON.parse(await env.KV.get('groups')||'[]');await env.KV.put('groups',JSON.stringify(gs.filter(g=>g.id!==id)));await env.KV.delete('ips:'+id);return json({ok:1})}
      // 触发GitHub Actions检测
      if(path==='/api/trigger-actions'&&req.method==='POST'){
        const ghToken=cfg.githubToken;const ghRepo=cfg.githubRepo;
        if(!ghToken||!ghRepo)return json({error:'未配置GitHub Token或仓库'},400);
        try{
          const r=await fetch(`https://api.github.com/repos/${ghRepo}/actions/workflows/check-proxy.yml/dispatches`,{
            method:'POST',headers:{'Authorization':`Bearer ${ghToken}`,'Content-Type':'application/json','User-Agent':'ProxyIP-Manager'},
            body:JSON.stringify({ref:'main'})
          });
          if(!r.ok){
            const errText=await r.text();
            console.error('GitHub API错误:',r.status,errText);
            return json({error:'触发失败: '+r.status+' - '+errText},500);
          }
          return json({ok:1,msg:'GitHub Actions已触发'});
        }catch(e){return json({error:e.message},500)}
      }
      if(path==='/api/check'&&req.method==='POST'){ctx.waitUntil(autoCheckAndResolve(env));return json({ok:1,msg:'检测已触发'})}

      if(path==='/api/check-group'&&req.method==='POST'){
        const{groupId}=await req.json();if(!groupId)return json({error:'需要分组ID'},400);
        ctx.waitUntil((async()=>{
          const cf=JSON.parse(await env.KV.get('config')||'{}');
          const gs=JSON.parse(await env.KV.get('groups')||'[]');const g=gs.find(x=>x.id===groupId);if(!g)return;
          const bl=new Set(JSON.parse(await env.KV.get('blacklist')||'[]'));
          let gips=JSON.parse(await env.KV.get('ips:'+groupId)||'[]');
          let toCheck=gips.filter(ip=>!bl.has(ip.ip));
          if(!toCheck.length)return;
          await env.KV.put('check_progress',JSON.stringify({phase:'checking',checked:0,total:toCheck.length,valid:0,invalid:0,group:g.name}));
          const checked=await batchCheck(toCheck,async(p)=>{
            await env.KV.put('check_progress',JSON.stringify({...p,group:g.name}));
          });
          const resultMap=new Map(checked.map(i=>[i.ipPort,i]));
          const validSet=new Set(checked.filter(i=>i.status==='valid').map(i=>i.ipPort));

          // 收集失效IP到回收站
          const invalidIPs=checked.filter(i=>i.status==='invalid');
          if(invalidIPs.length>0){
            const groupTrash=JSON.parse(await env.KV.get('trash:'+groupId)||'[]');
            const now=new Date().toISOString();
            invalidIPs.forEach(ip=>{
              groupTrash.push({...ip,deletedAt:now,deletedReason:ip.failReason||'unknown'});
            });
            await env.KV.put('trash:'+groupId,JSON.stringify(groupTrash));
          }

          // 更新IP列表，移除失效IP
          gips=gips.map(ip=>resultMap.get(ip.ipPort)||ip);
          const validIPs=gips.filter(i=>i.status!=='invalid');
          await env.KV.put('ips:'+groupId,JSON.stringify(validIPs));

          await env.KV.put('check_progress',JSON.stringify({phase:'resolving',checked:checked.length,total:toCheck.length,valid:validSet.size,invalid:checked.length-validSet.size,group:g.name}));
          let gv=validIPs.filter(i=>i.status==='valid');
          if(g.selectedAsns?.length)gv=gv.filter(i=>g.selectedAsns.includes(i.asn));
          const sorted=[...gv].sort((a,b)=>a.checkLatency-b.checkLatency);
          const resolved=sorted.slice(0,g.resolveCount||8);
          let ok=false,err='';
          if(resolved.length){try{ok=await resolveToCloudflare(g,resolved)}catch(e){err=e.message}}
          const failedIPs=checked.filter(i=>i.status==='invalid');
          const reasonMap={};failedIPs.forEach(i=>{const r=i.failReason||'unknown';reasonMap[r]=(reasonMap[r]||0)+1});
          const reasonLabels={timeout:'超时',network_error:'网络错误',api_fail:'API返回失败',unknown:'未知'};
          const reasonStr=Object.entries(reasonMap).map(([k,v])=>(reasonLabels[k]||k)+':'+v).join(' | ');
          const result={time:new Date().toISOString(),total:toCheck.length,checked:checked.length,valid:validSet.size,invalid:checked.length-validSet.size,failReasons:reasonMap,
            groups:[{id:g.id,name:g.name,domain:g.domain,ok,err,count:validIPs.length,resolved:resolved.map(i=>i.ipPort+'('+i.checkLatency+'ms)')}]};
          await env.KV.put('last_result',JSON.stringify(result));
          await env.KV.put('check_progress',JSON.stringify({phase:'done',checked:checked.length,total:toCheck.length,valid:validSet.size,invalid:checked.length-validSet.size,group:g.name}));
          let tgMsg='<b>🔍 ['+g.name+']检测报告</b>\n⏰'+result.time+'\n📊 总:'+toCheck.length+' ✅'+validSet.size+' ❌'+(checked.length-validSet.size);
          if(reasonStr)tgMsg+='\n📋 失效原因: '+reasonStr;
          if(invalidIPs.length>0)tgMsg+='\n🗑️ 已移除'+invalidIPs.length+'个失效IP到回收站';
          const recordType=g.recordType||'TXT';
          tgMsg+='\n🌐 DNS类型: '+recordType+' '+(ok?'✅':'❌')+(err?' '+err:'');
          tgMsg+='\n'+(resolved.length?resolved.map(i=>i.ipPort+'('+i.checkLatency+'ms)').join('\n'):'无有效IP');
          await sendTG(cf,tgMsg);
        })());
        return json({ok:1,msg:'分组检测已触发'});
      }
      if(path==='/api/resolve'&&req.method==='POST'){
        const{groupId}=await req.json();const gs=JSON.parse(await env.KV.get('groups')||'[]');const g=gs.find(x=>x.id===groupId);
        if(!g)return json({error:'分组不存在'},400);
        const bl=new Set(JSON.parse(await env.KV.get('blacklist')||'[]'));
        let v=JSON.parse(await env.KV.get('ips:'+groupId)||'[]').filter(i=>i.status==='valid'&&!bl.has(i.ip));
        if(g.selectedAsns?.length)v=v.filter(i=>g.selectedAsns.includes(i.asn));
        v.sort((a,b)=>a.checkLatency-b.checkLatency);const toR=v.slice(0,g.resolveCount||8);
        if(!toR.length)return json({error:'无有效IP'},400);
        try{await resolveToCloudflare(g,toR);return json({ok:1,resolved:toR.map(i=>i.ipPort)})}catch(e){return json({error:e.message},500)}
      }
      if(path==='/api/resolve-selected'&&req.method==='POST'){
        const{groupId,ipPorts}=await req.json();const gs=JSON.parse(await env.KV.get('groups')||'[]');const g=gs.find(x=>x.id===groupId);
        if(!g)return json({error:'分组不存在'},400);
        const ips=JSON.parse(await env.KV.get('ips:'+groupId)||'[]');const toR=ips.filter(i=>ipPorts.includes(i.ipPort));
        if(!toR.length)return json({error:'未选择IP'},400);
        try{await resolveToCloudflare(g,toR);return json({ok:1,resolved:toR.map(i=>i.ipPort)})}catch(e){return json({error:e.message},500)}
      }
      if(path==='/api/status')return json(JSON.parse(await env.KV.get('last_result')||'{}'));
      if(path==='/api/progress')return json(JSON.parse(await env.KV.get('check_progress')||'{"phase":"idle"}'));
      // 回收站API
      if(path==='/api/trash'){
        const groupId=new URL(req.url).searchParams.get('groupId');
        if(!groupId)return json({error:'需要分组ID'},400);
        if(req.method==='GET')return json(JSON.parse(await env.KV.get('trash:'+groupId)||'[]'));
        if(req.method==='DELETE'){await env.KV.delete('trash:'+groupId);return json({ok:1})}
        return json({error:'Method not allowed'},405);
      }
      if(path==='/api/restore'&&req.method==='POST'){
        const{ipPorts,groupId}=await req.json();
        if(!ipPorts||!groupId)return json({error:'缺少参数'},400);
        const trash=JSON.parse(await env.KV.get('trash:'+groupId)||'[]');
        const toRestore=trash.filter(i=>ipPorts.includes(i.ipPort));
        const remaining=trash.filter(i=>!ipPorts.includes(i.ipPort));
        await env.KV.put('trash:'+groupId,JSON.stringify(remaining));
        let gips=JSON.parse(await env.KV.get('ips:'+groupId)||'[]');
        toRestore.forEach(ip=>{delete ip.deletedAt;delete ip.deletedReason;ip.status='unchecked'});
        gips.push(...toRestore);
        await env.KV.put('ips:'+groupId,JSON.stringify(gips));
        return json({ok:1,restored:toRestore.length});
      }
      // FOFA搜索API - 只搜索并保存，不检测
      if(path==='/api/fofa-search'&&req.method==='POST'){
        const{groupId}=await req.json();
        if(!groupId)return json({error:'需要分组ID'},400);
        const gs=JSON.parse(await env.KV.get('groups')||'[]');
        const g=gs.find(x=>x.id===groupId);
        if(!g)return json({error:'分组不存在'},400);
        if(!g.fofaQuery)return json({error:'未配置FOFA查询语法'},400);
        if(!cfg.fofaKey)return json({error:'未配置FOFA Key'},400);

        try{
          const qbase64=btoa(g.fofaQuery);
          const size=g.fofaSize||10000;
          const url=`https://fofoapi.com/api/v1/search/all?qbase64=${qbase64}&key=${cfg.fofaKey}&size=${size}&fields=ip,port,as_number,as_organization,city,country`;

          const res=await fetch(url);
          const data=await res.json();

          if(!data.results||!data.results.length)return json({ok:1,found:0,added:0,msg:'FOFA未搜索到结果'});

          const newIPs=data.results.map(r=>{
            const[ip,port,asn,org,city,country]=r;
            return{ipPort:`${ip}:${port}`,ip,port:+port,asn:asn||'',org:org||'',city:city||'',country:country||'',
              status:'unchecked',lastCheck:'',checkLatency:9999,colo:'',riskLevel:'',riskScore:'',latency:9999,company:''};
          });

          // 去重：排除现有IP和回收站IP
          const old=JSON.parse(await env.KV.get('ips:'+groupId)||'[]');
          const groupTrash=JSON.parse(await env.KV.get('trash:'+groupId)||'[]');
          const existingIPs=new Set(old.map(i=>i.ipPort));
          const trashIPs=new Set(groupTrash.map(t=>t.ipPort));
          const toAdd=newIPs.filter(i=>!existingIPs.has(i.ipPort)&&!trashIPs.has(i.ipPort));

          if(!toAdd.length)return json({ok:1,found:data.results.length,added:0,msg:'无新增IP(全部重复或在回收站中)'});

          // 直接保存到IP列表
          await env.KV.put('ips:'+groupId,JSON.stringify([...old,...toAdd]));

          // 自动触发GitHub Actions检测
          let actionsTriggered=false;
          if(cfg.githubToken&&cfg.githubRepo){
            try{
              const r=await fetch(`https://api.github.com/repos/${cfg.githubRepo}/actions/workflows/check-proxy.yml/dispatches`,{
                method:'POST',headers:{'Authorization':`Bearer ${cfg.githubToken}`,'Content-Type':'application/json','User-Agent':'ProxyIP-Manager'},
                body:JSON.stringify({ref:'main'})
              });
              actionsTriggered=r.ok;
            }catch{}
          }

          // 发送通知
          let tgMsg=`<b>🔍 FOFA搜索完成 [${g.name}]</b>\n`;
          tgMsg+=`⏰ ${new Date().toISOString()}\n`;
          tgMsg+=`📊 搜索到: ${data.results.length} | 新增: ${toAdd.length}\n`;
          tgMsg+=actionsTriggered?'🚀 已自动触发GitHub Actions检测':'⚠️ 未配置GitHub Actions，请手动检测';
          await sendTG(cfg,tgMsg);

          return json({ok:1,found:data.results.length,added:toAdd.length,actionsTriggered,msg:'已保存'+toAdd.length+'个新IP'+(actionsTriggered?'，已触发Actions检测':'')});
        }catch(e){return json({error:'FOFA搜索失败: '+e.message},500)}
      }
      return json({error:'Not Found'},404);
    }
    const HTML=`<!DOCTYPE html><html lang="zh"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>ProxyIP Manager</title><style>
    :root{--bg:#0d1117;--cd:#161b22;--bd:#30363d;--tx:#e6edf3;--dm:#8b949e;--bl:#58a6ff;--gn:#3fb950;--rd:#f85149;--yl:#d29922}
    *{margin:0;padding:0;box-sizing:border-box}body{font:14px/1.6 system-ui,sans-serif;background:var(--bg);color:var(--tx)}
    .w{max-width:1100px;margin:0 auto;padding:16px}
    header{display:flex;align-items:center;justify-content:space-between;padding:12px 0;border-bottom:1px solid var(--bd);margin-bottom:12px}
    header h1{font-size:18px}header span{color:var(--dm);font-size:12px}
    nav{display:flex;gap:4px;margin-bottom:12px;border-bottom:1px solid var(--bd);padding-bottom:8px;flex-wrap:wrap}
    nav a{padding:5px 12px;border-radius:6px;cursor:pointer;color:var(--dm);font-size:13px;user-select:none}
    nav a:hover{color:var(--tx);background:#21262d}nav a.on{color:var(--bl);background:#1c2333}
    .tab{display:none}.tab.on{display:block}
    .cd{background:var(--cd);border:1px solid var(--bd);border-radius:8px;padding:14px;margin-bottom:10px}
    .cd h3{font-size:13px;margin-bottom:8px;color:var(--bl)}
    .row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
    .st{text-align:center;padding:10px 16px;flex:1;min-width:80px}.st b{display:block;font-size:20px}.st span{color:var(--dm);font-size:11px}
    input,select,textarea{background:#0d1117;border:1px solid var(--bd);color:var(--tx);padding:5px 8px;border-radius:5px;font-size:13px;width:100%}
    input:focus,textarea:focus{outline:none;border-color:var(--bl)}select{width:auto;min-width:100px}
    textarea{resize:vertical;min-height:50px;font-family:monospace}
    label{display:block;color:var(--dm);font-size:11px;margin:6px 0 2px}
    .btn{display:inline-flex;align-items:center;gap:3px;padding:5px 12px;border-radius:5px;border:1px solid var(--bd);background:var(--cd);color:var(--tx);cursor:pointer;font-size:12px}
    .btn:hover{border-color:var(--bl);color:var(--bl)}.btn.p{background:#1f6feb;border-color:#1f6feb;color:#fff}.btn.p:hover{background:#388bfd}
    .btn.d{border-color:var(--rd);color:var(--rd)}.btn:disabled{opacity:.4;pointer-events:none}
    table{width:100%;border-collapse:collapse;font-size:12px}th,td{padding:4px 6px;text-align:left;border-bottom:1px solid var(--bd)}
    th{color:var(--dm);font-size:11px;position:sticky;top:0;background:var(--cd)}tr:hover td{background:#1c2333}
    .tw{max-height:380px;overflow-y:auto}
    .tg{display:inline-block;padding:1px 5px;border-radius:3px;font-size:10px}
    .tg.v{background:#3fb95022;color:var(--gn)}.tg.i{background:#f8514922;color:var(--rd)}.tg.u{background:#d2992222;color:var(--yl)}
    .uz{border:2px dashed var(--bd);border-radius:8px;padding:20px;text-align:center;cursor:pointer;color:var(--dm);font-size:13px}
    .uz:hover,.uz.drag{border-color:var(--bl);color:var(--bl)}
    .tt{position:fixed;top:12px;right:12px;padding:8px 14px;border-radius:6px;font-size:13px;z-index:99;animation:fi .3s}
    .tt.ok{background:#238636;color:#fff}.tt.er{background:#da3633;color:#fff}
    @keyframes fi{from{opacity:0;transform:translateY(-8px)}to{opacity:1}}
    .ch{display:inline-block;padding:2px 7px;margin:2px;border-radius:10px;font-size:11px;border:1px solid var(--bd);cursor:pointer;user-select:none}
    .ch.s{background:var(--bl);border-color:var(--bl);color:#fff}
    #login{display:flex;justify-content:center;align-items:center;min-height:80vh}
    #login .cd{width:300px;text-align:center}
    .fe{display:flex;justify-content:flex-end;gap:6px;margin-top:8px}.hid{display:none!important}
    .gc{border-left:3px solid var(--bl);margin-bottom:8px}
    .pb{width:100%;height:20px;background:#0d1117;border-radius:10px;overflow:hidden;border:1px solid var(--bd)}
    .pf{height:100%;background:linear-gradient(90deg,#1f6feb,#58a6ff);border-radius:10px;transition:width .5s;display:flex;align-items:center;justify-content:center;font-size:10px;color:#fff;min-width:30px}
    .pg{margin-top:8px}.pg .row{margin-top:6px;font-size:12px}
    .pg b{font-size:13px}.pg .dm{color:var(--dm)}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
    .pulsing{animation:pulse 1.5s infinite}
    </style></head><body><div class="w">
    <div id="login"><div class="cd"><h3>🔐 ProxyIP Manager</h3><div id="li"></div></div></div>
    <div id="main" class="hid">
    <header><h1>⚡ ProxyIP Manager</h1><span id="hi"></span></header>
    <nav id="nav"></nav>
    <!-- 概览 -->
    <div class="tab on" id="t-ov">
    <div class="cd"><div class="row">
    <div class="st"><b id="s-c">-</b><span>检测数</span></div>
    <div class="st"><b id="s-v" style="color:var(--gn)">-</b><span>有效</span></div>
    <div class="st"><b id="s-i" style="color:var(--rd)">-</b><span>失效</span></div>
    </div></div>
    <div class="cd"><h3>快捷操作</h3><div class="row">
    <button class="btn p" onclick="doChk(this)">🔍 Workers检测 (快速)</button>
    <button class="btn p" onclick="triggerActions(this)">🚀 GitHub Actions检测 (推荐)</button>
    </div><p style="color:var(--dm);font-size:11px;margin-top:6px">Workers: 30秒限制 | Actions: 无限制，每2小时自动运行</p></div>
    <div class="cd hid" id="pg-box"><h3>检测进度</h3><div class="pg">
    <div class="row" style="justify-content:space-between"><b id="pg-phase">准备中...</b><span class="dm" id="pg-num">0/0</span></div>
    <div class="pb" style="margin-top:6px"><div class="pf" id="pg-bar" style="width:0%">0%</div></div>
    <div class="row" style="margin-top:6px;gap:16px">
    <span style="color:var(--gn)">✅ 有效: <b id="pg-v">0</b></span>
    <span style="color:var(--rd)">❌ 失效: <b id="pg-i">0</b></span>
    </div></div></div>
    <div class="cd"><h3>分组状态</h3><div id="ov-gr">暂无数据</div></div>
    </div>
    <!-- IP管理(按分组) -->
    <div class="tab" id="t-ip">
    <div class="cd"><div class="row">
    <b>当前分组:</b><select id="ip-grp" onchange="chgGrp()"><option value="">请选择</option></select>
    </div></div>
    <div id="ip-panel" class="hid">
    <div class="cd"><h3>上传CSV到此分组</h3>
    <div class="uz" id="dz" onclick="document.getElementById('cf').click()">📁 点击或拖拽CSV上传</div>
    <input type="file" id="cf" accept=".csv" class="hid" onchange="upCSV(this)">
    </div>
    <div class="cd"><h3>ASN筛选</h3><div id="asn-c" class="row"></div></div>
    <div class="cd"><h3>IP列表 <span id="ipc" style="color:var(--dm)"></span></h3>
    <div class="row" style="margin-bottom:6px">
    <button class="btn" onclick="selA()">全选</button>
    <button class="btn p" onclick="doChkGrp(this)">🔍 检测本组</button>
    <button class="btn p" onclick="resSel(this)">🌐 解析选中</button>
    <button class="btn p" onclick="resGrpBtn(this)">🌐 自动解析最优</button>
    <button class="btn d" onclick="delSel()">删除选中</button>
    </div>
    <div id="pagination" class="row" style="margin-bottom:6px;justify-content:center;display:none">
    <button class="btn" onclick="goPage(1)" id="btn-first">首页</button>
    <button class="btn" onclick="goPage(currentPage-1)" id="btn-prev">上一页</button>
    <span style="color:var(--dm);padding:0 12px" id="page-info">第1页/共1页</span>
    <button class="btn" onclick="goPage(currentPage+1)" id="btn-next">下一页</button>
    <button class="btn" onclick="goPage(totalPages)" id="btn-last">末页</button>
    </div>
    <div class="tw"><table><thead><tr>
    <th><input type="checkbox" id="ca" onchange="togA(this)"></th>
    <th>IP:端口</th><th>ASN</th><th>延迟</th><th>机房</th><th>城市</th><th>组织</th><th>状态</th><th>失效原因</th>
    </tr></thead><tbody id="tb"></tbody></table></div>
  <div id="pg2" class="row" style="margin-top:8px;justify-content:center;display:none">
  <button class="btn" onclick="goPage(1)">首页</button>
  <button class="btn" onclick="goPage(currentPage-1)">上一页</button>
  <span style="color:var(--dm);padding:0 12px" id="page-info2">1/1</span>
  <button class="btn" onclick="goPage(currentPage+1)">下一页</button>
  <button class="btn" onclick="goPage(totalPages)">末页</button>
  </div>
  </div>
    </div></div>
    <!-- 分组管理 -->
    <div class="tab" id="t-gr">
    <div class="cd"><h3>添加/编辑分组</h3>
    <div class="row"><div style="flex:1"><label>分组ID(英文)</label><input id="g-id" placeholder="如kr"></div>
    <div style="flex:1"><label>分组名称</label><input id="g-nm" placeholder="如韩国"></div></div>
    <label>CF API Token</label><input id="g-tk" type="password">
    <label>Zone ID</label><input id="g-zn">
    <label>解析域名</label><input id="g-dm" placeholder="proxy.example.com">
    <label>DNS记录类型</label>
    <select id="g-rt">
      <option value="TXT">TXT记录 (多IP逗号分隔)</option>
      <option value="A">A记录 (多条记录)</option>
    </select>
    <label>每次解析数</label><input id="g-ct" type="number" value="8" min="1" max="50">
    <label>ASN过滤(点选,不选=全部)</label><div id="g-asn" class="row"></div>
    <label>FOFA搜索语法 <span style="color:var(--dm);font-size:11px">(可选,留空则不使用FOFA)</span></label>
    <input id="g-fofa-q" placeholder='如: country="KR" && port="443"'>
    <label>FOFA搜索数量</label><input id="g-fofa-sz" type="number" value="10000" min="100" max="10000">
    <label>FOFA定时搜索</label>
    <select id="g-fofa-cron"><option value="">不启用</option><option value="2">每2小时</option><option value="4">每4小时</option><option value="6">每6小时</option><option value="12">每12小时</option><option value="24">每24小时</option></select>
    <p style="color:var(--dm);font-size:11px;margin-top:2px">定时只保存新IP不检测。需在Workers设置Cron触发器(如每小时: 0 * * * *)</p>
    <div class="fe"><button class="btn" onclick="clrGF()">清空</button><button class="btn p" onclick="saveGrp()">保存分组</button></div>
    </div><div id="gl"></div>
    </div>
    <!-- 黑名单 -->
    <div class="tab" id="t-bl">
    <div class="cd"><h3>全局IP黑名单</h3><p style="color:var(--dm);font-size:11px;margin-bottom:6px">每行一个IP</p>
    <textarea id="blt" rows="8"></textarea>
    <div class="fe"><button class="btn p" onclick="saveBL()">保存</button></div>
    </div></div>
    <!-- 回收站 -->
    <div class="tab" id="t-trash">
    <div class="cd"><h3>回收站 <span id="trash-c" style="color:var(--dm)"></span></h3>
    <p style="color:var(--dm);font-size:11px;margin-bottom:6px">检测失效的IP会自动移到这里，不再参与检测</p>
    <div class="row" style="margin-bottom:6px">
    <select id="trash-grp" onchange="loadTrash()" style="flex:1;margin-right:6px">
      <option value="">选择分组</option>
    </select>
    <button class="btn" onclick="selATrash()">全选</button>
    <button class="btn p" onclick="restoreTrash()">恢复选中</button>
    <button class="btn d" onclick="clearTrash()">清空回收站</button>
    </div>
    <div class="tw"><table><thead><tr>
    <th><input type="checkbox" id="ca-trash" onchange="togATrash(this)"></th>
    <th>IP:端口</th><th>ASN</th><th>国家</th><th>失效原因</th><th>删除时间</th>
    </tr></thead><tbody id="tb-trash"></tbody></table></div>
    </div></div>
    <!-- 设置 -->
    <div class="tab" id="t-st">
    <div class="cd"><h3>GitHub Actions配置</h3>
    <label>GitHub Token</label><input id="c-gh-token" type="password" placeholder="ghp_...">
    <label>仓库 (格式: 用户名/仓库名)</label><input id="c-gh-repo" placeholder="luckyf1oat/proxyip-worker">
    <p style="color:var(--dm);font-size:11px;margin-top:4px">Token权限: repo > actions (write)</p>
    </div>
    <div class="cd"><h3>Telegram通知</h3>
    <label>Bot Token</label><input id="c-tt" type="password">
    <label>Chat ID</label><input id="c-tc">
    </div>
    <div class="cd"><h3>FOFA API配置</h3>
    <label>FOFA Key</label><input id="c-fofa-key" type="password" placeholder="pji6u9f70263l3lkudd2fb7hhjiw1wmp">
    <p style="color:var(--dm);font-size:11px;margin-top:4px">用于自动搜索代理IP</p>
    </div>
    <div class="cd"><h3>修改密码</h3><label>新密码(留空不改)</label><input id="c-pw" type="password"></div>
    <div class="fe"><button class="btn p" onclick="saveCfg()">保存设置</button></div>
    </div>
    </div></div>
    <script>
    let P=localStorage.getItem('_pp')||'',GRPS=[],CG='',IPS=[],ASNS=[],SA=new Set(),GA=new Set(),TRASH=[],TG='',currentPage=1;
    const $=id=>document.getElementById(id);
    const PAGE_SIZE=100;
    function tt(m,ok=1){const d=document.createElement('div');d.className='tt '+(ok?'ok':'er');d.textContent=m;document.body.appendChild(d);setTimeout(()=>d.remove(),3000)}
    async function api(u,o={}){const r=await fetch(u,{...o,headers:{...o.headers,'X-Auth':P}});const d=await r.json();if(!r.ok)throw new Error(d.error||'失败');return d}
    function dis(b,v){if(b)b.disabled=v}
    const Q="'";
    const tabs=[['ov','概览'],['ip','IP管理'],['gr','分组管理'],['bl','黑名单'],['trash','回收站'],['st','设置']];
    $('nav').innerHTML=tabs.map(([k,v],i)=>'<a onclick="sw('+Q+k+Q+')" id="n-'+k+'"'+(i===0?' class="on"':'')+'>'+v+'</a>').join('');
    function sw(k){document.querySelectorAll('.tab').forEach(t=>t.classList.remove('on'));document.querySelectorAll('nav a').forEach(a=>a.classList.remove('on'));$('t-'+k)?.classList.add('on');$('n-'+k)?.classList.add('on');if(k==='ov')loadSt();if(k==='ip'&&CG)chgGrp();if(k==='gr')loadGrps();if(k==='bl')loadBL();if(k==='trash')loadTrash();if(k==='st')loadCfg()}

    async function init(){
      const{needSetup}=await api('/api/init');
      if(needSetup){$('li').innerHTML='<label>设置管理密码</label><input id="pw" type="password"><div class="fe"><button class="btn p" onclick="doSetup()">初始化</button></div>'}
      else if(P){try{await api('/api/config');enter()}catch{P='';localStorage.removeItem('_pp');showLogin()}}
      else showLogin();
    }
    function showLogin(){$('li').innerHTML='<label>输入密码</label><input id="pw" type="password" onkeydown="event.key==='+Q+'Enter'+Q+'&&doLogin()"><div class="fe"><button class="btn p" onclick="doLogin()">登录</button></div>'}
    async function doSetup(){const p=$('pw').value;if(!p)return tt('请输入密码',0);P=p;localStorage.setItem('_pp',p);await api('/api/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:p})});tt('初始化成功');enter()}
    async function doLogin(){P=$('pw').value;try{await api('/api/config');localStorage.setItem('_pp',P);tt('登录成功');enter()}catch{tt('密码错误',0);P='';localStorage.removeItem('_pp')}}
    function enter(){$('login').classList.add('hid');$('main').classList.remove('hid');loadAll()}

    async function loadAll(){await Promise.all([loadSt(),loadGrps(),loadCfg(),loadBL()]);checkRunning()}
    async function loadSt(){
      try{const r=await api('/api/status');
      $('s-c').textContent=(r.checked??'-')+'/'+(r.total??'-');$('s-v').textContent=r.valid??'-';$('s-i').textContent=r.invalid??'-';
      const rl={timeout:'超时',network_error:'网络错误',api_fail:'API失败',unknown:'未知'};
      const frHtml=r.failReasons?Object.entries(r.failReasons).map(([k,v])=>'<span style="color:var(--rd);font-size:11px;margin-right:8px">'+(rl[k]||k)+':'+v+'</span>').join(''):'';
      if(r.groups?.length){$('ov-gr').innerHTML=(frHtml?'<div class="cd" style="margin-bottom:8px"><b style="font-size:12px">📋 失效原因统计</b><br>'+frHtml+'</div>':'')+r.groups.map(g=>'<div class="cd gc"><b>'+g.name+'</b> → '+g.domain+' '+(g.ok?'✅':'❌')+(g.err?' '+g.err:'')+'<br><small style="color:var(--dm)">IP:'+g.count+' | '+(g.resolved?.join(', ')||'无')+'</small></div>').join('')}
      else $('ov-gr').textContent=r.time?new Date(r.time).toLocaleString():'暂无'}catch{}
    }
    async function loadGrps(){
      GRPS=await api('/api/groups');renderGrps();
      const opts=GRPS.map(g=>'<option value="'+g.id+'">'+g.name+'('+g.id+')</option>').join('');
      $('ip-grp').innerHTML='<option value="">请选择</option>'+opts;
      $('trash-grp').innerHTML='<option value="">选择分组</option>'+opts;
      if(CG&&GRPS.find(g=>g.id===CG)){$('ip-grp').value=CG;chgGrp()}
      $('hi').textContent=GRPS.length?GRPS.length+'个分组':'未配置分组';
    }
    function renderGrps(){
      $('gl').innerHTML=GRPS.length?GRPS.map(g=>'<div class="cd gc"><div class="row" style="justify-content:space-between"><b>'+g.name+'('+g.id+')</b><div><button class="btn" onclick="editGrp('+Q+g.id+Q+')">编辑</button> '+(g.fofaQuery?'<button class="btn p" onclick="fofaSearch('+Q+g.id+Q+',this)">🔍FOFA</button> ':'')+' <button class="btn p" onclick="resGrp('+Q+g.id+Q+',this)">🌐解析</button> <button class="btn d" onclick="delGrp('+Q+g.id+Q+')">删除</button></div></div><p style="color:var(--dm);font-size:11px;margin-top:4px">'+g.domain+' | 数量:'+g.resolveCount+' | ASN:'+(g.selectedAsns?.length?g.selectedAsns.map(a=>'AS'+a).join(','):'全部')+(g.fofaQuery?' | FOFA:'+g.fofaSize:'')+(g.fofaCron?' | 定时:每'+g.fofaCron+'h':'')+'</p></div>').join(''):'<p style="color:var(--dm);padding:8px">暂无分组</p>';
    }
    // IP管理(按分组)
    async function chgGrp(){
      CG=$('ip-grp').value;
      if(!CG){$('ip-panel').classList.add('hid');return}
      $('ip-panel').classList.remove('hid');SA.clear();currentPage=1;
      const{ips}=await api('/api/ips?groupId='+CG);IPS=ips;
      ASNS=await api('/api/asns?groupId='+CG);renderChips();renderTbl();
    }
    function renderChips(){$('asn-c').innerHTML=ASNS.map(a=>'<span class="ch'+(SA.has(a.asn)?' s':'')+'" onclick="togF('+Q+a.asn+Q+')">AS'+a.asn+'('+a.count+')</span>').join('')||'<span style="color:var(--dm)">暂无</span>'}
    function renderGAChips(){$('g-asn').innerHTML=ASNS.length?ASNS.map(a=>'<span class="ch'+(GA.has(a.asn)?' s':'')+'" onclick="togGA('+Q+a.asn+Q+')">AS'+a.asn+'('+a.count+')</span>').join(''):'<span style="color:var(--dm)">先上传CSV到分组</span>'}
    function togF(a){SA.has(a)?SA.delete(a):SA.add(a);renderChips();currentPage=1;renderTbl()}
    function togGA(a){GA.has(a)?GA.delete(a):GA.add(a);renderGAChips()}
    function renderTbl(){
      let l=SA.size?IPS.filter(i=>SA.has(i.asn)):IPS;
      l=[...l].sort((a,b)=>(a.checkLatency||9999)-(b.checkLatency||9999));
      const tp=Math.ceil(l.length/PAGE_SIZE)||1;
      if(currentPage>tp)currentPage=tp;
      const pageData=l.slice((currentPage-1)*PAGE_SIZE,currentPage*PAGE_SIZE);
      $('ipc').textContent='('+l.length+'/'+IPS.length+')';
      $('tb').innerHTML=pageData.map(i=>'<tr><td><input type="checkbox" class="ck" value="'+i.ipPort+'"></td><td>'+i.ipPort+'</td><td>AS'+i.asn+'</td><td>'+(i.checkLatency<9999?i.checkLatency+'ms':i.latency+'ms')+'</td><td>'+i.colo+'</td><td>'+i.city+'</td><td>'+(i.org||'')+'</td><td><span class="tg '+(i.status==='valid'?'v':i.status==='invalid'?'i':'u')+'">'+(i.status==='valid'?'有效':i.status==='invalid'?'失效':'未检测')+'</span></td><td style="color:var(--rd);font-size:11px">'+(i.status==='invalid'&&i.failReason?i.failReason:'')+'</td></tr>').join('');
      window.totalPages=tp;
      var show=l.length>PAGE_SIZE;
      var info='第'+currentPage+'页/共'+tp+'页 (共'+l.length+'条)';
      $('pagination').style.display=show?'flex':'none';
      if($('pg2'))$('pg2').style.display=show?'flex':'none';
      if(show){
        $('page-info').textContent=info;if($('page-info2'))$('page-info2').textContent=info;
        $('btn-first').disabled=currentPage===1;$('btn-prev').disabled=currentPage===1;
        $('btn-next').disabled=currentPage>=tp;$('btn-last').disabled=currentPage>=tp;
      }
    }
    function goPage(p){if(p<1||p>window.totalPages)return;currentPage=p;renderTbl()}
    function togA(e){document.querySelectorAll('.ck').forEach(c=>c.checked=e.checked)}
    function selA(){document.querySelectorAll('.ck').forEach(c=>c.checked=true);if($('ca'))$('ca').checked=true}
    function getSel(){return[...document.querySelectorAll('.ck:checked')].map(c=>c.value)}
    async function checkRunning(){try{const p=await api('/api/progress');if(p.phase==='checking'||p.phase==='rechecking'||p.phase==='resolving'){$('pg-box').classList.remove('hid');sw('ov');startPoll()}}catch{}}
    async function doChk(b){
      dis(b,1);
      try{
        await api('/api/check',{method:'POST'});tt('全部检测已触发');
        sw('ov');$('pg-box').classList.remove('hid');startPoll();
      }catch(e){tt(e.message,0);dis(b,0)}
    }
    async function doChkGrp(b){
      if(!CG)return tt('请选择分组',0);
      dis(b,1);
      try{
        await api('/api/check-group',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({groupId:CG})});
        tt('分组检测已触发');sw('ov');$('pg-box').classList.remove('hid');startPoll();
      }catch(e){tt(e.message,0);dis(b,0)}
    }
    let _poll=null,_lastTick='',_staleAt=0;
    function startPoll(){if(_poll)return;_lastTick='';_staleAt=0;_poll=setInterval(pollProgress,1500);pollProgress()}
    function stopPoll(){if(_poll){clearInterval(_poll);_poll=null}}
    async function pollProgress(){
      try{
        const p=await api('/api/progress');
        const isRecheck=p.phase==='rechecking';
        const pct=isRecheck?(p.recheckTotal>0?Math.round(p.recheck/p.recheckTotal*100):0):(p.total>0?Math.round(p.checked/p.total*100):0);
        const phases={checking:'🔍 检测中',rechecking:'🔄 失效重测',resolving:'🌐 解析中',done:'✅ 完成',idle:'⏸ 空闲'};
        $('pg-phase').textContent=(p.group?'['+p.group+'] ':'')+(phases[p.phase]||p.phase)+(isRecheck?' ('+p.recheck+'/'+p.recheckTotal+')':'');
        $('pg-num').textContent=isRecheck?p.recheck+'/'+p.recheckTotal:p.checked+'/'+p.total;
        $('pg-bar').style.width=Math.max(pct,2)+'%';$('pg-bar').textContent=pct+'%';
        $('pg-v').textContent=p.valid||0;$('pg-i').textContent=p.invalid||0;
        if(p.phase==='checking'||isRecheck)$('pg-bar').classList.add('pulsing');
        else $('pg-bar').classList.remove('pulsing');
        if(p.phase==='checking'||isRecheck||p.phase==='resolving'){
          const tick=p.phase+':'+p.checked+':'+p.valid+':'+(p.recheck||0);
          if(tick!==_lastTick){_lastTick=tick;_staleAt=Date.now()}
          else if(_staleAt&&Date.now()-_staleAt>300000){
            stopPoll();$('pg-phase').textContent='⚠️ 检测超时，请重试';$('pg-bar').classList.remove('pulsing');
            document.querySelectorAll('.btn.p:disabled').forEach(b=>b.disabled=false);
            return;
          }
        }
        if(p.phase==='done'){
          stopPoll();tt('检测完成: ✅'+p.valid+' ❌'+p.invalid);
          loadSt();if(CG)chgGrp();
          document.querySelectorAll('.btn.p:disabled').forEach(b=>b.disabled=false);
          setTimeout(()=>$('pg-box').classList.add('hid'),8000);
        }
      }catch{}
    }
    async function resSel(b){
      if(!CG)return tt('请选择分组',0);const s=getSel();if(!s.length)return tt('请先选择IP',0);
      dis(b,1);try{const r=await api('/api/resolve-selected',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({groupId:CG,ipPorts:s})});tt('已解析'+r.resolved.length+'条');loadSt()}catch(e){tt(e.message,0)}finally{dis(b,0)}
    }
    async function resGrpBtn(b){
      if(!CG)return tt('请选择分组',0);
      dis(b,1);try{const r=await api('/api/resolve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({groupId:CG})});tt('已解析: '+r.resolved.join(', '));loadSt()}catch(e){tt(e.message,0)}finally{dis(b,0)}
    }
    async function delSel(){const s=getSel();if(!s.length)return tt('请先选择',0);if(!confirm('确认删除'+s.length+'条？'))return;try{await api('/api/delete-ip',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({groupId:CG,ipPorts:s})});tt('已删除');chgGrp()}catch(e){tt(e.message,0)}}
    function upCSV(input){if(!CG)return tt('请先选择分组',0);const f=input.files[0];if(!f)return;const r=new FileReader();r.onload=async()=>{try{const d=await api('/api/upload',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({groupId:CG,csv:r.result})});tt('新增'+d.added+'条,总计'+d.total);chgGrp()}catch(e){tt(e.message,0)}};r.readAsText(f);input.value=''}
    const dz=$('dz');if(dz){dz.ondragover=e=>{e.preventDefault();dz.classList.add('drag')};dz.ondragleave=()=>dz.classList.remove('drag');dz.ondrop=e=>{e.preventDefault();dz.classList.remove('drag');if(!CG)return tt('请先选择分组',0);const f=e.dataTransfer.files[0];if(f){const rd=new FileReader();rd.onload=async()=>{try{const d=await api('/api/upload',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({groupId:CG,csv:rd.result})});tt('新增'+d.added+'条');chgGrp()}catch(e2){tt(e2.message,0)}};rd.readAsText(f)}}}
    // 分组管理
    function editGrp(id){const g=GRPS.find(x=>x.id===id);if(!g)return;$('g-id').value=g.id;$('g-id').readOnly=true;$('g-nm').value=g.name||'';$('g-tk').value=g.cfToken||'';$('g-zn').value=g.zoneId||'';$('g-dm').value=g.domain||'';$('g-rt').value=g.recordType||'TXT';$('g-ct').value=g.resolveCount||8;$('g-fofa-q').value=g.fofaQuery||'';$('g-fofa-sz').value=g.fofaSize||10000;$('g-fofa-cron').value=g.fofaCron||'';GA=new Set(g.selectedAsns||[]);renderGAChips();sw('gr')}
    function clrGF(){$('g-id').value='';$('g-id').readOnly=false;$('g-nm').value='';$('g-tk').value='';$('g-zn').value='';$('g-dm').value='';$('g-rt').value='TXT';$('g-ct').value=8;$('g-fofa-q').value='';$('g-fofa-sz').value=10000;$('g-fofa-cron').value='';GA.clear();renderGAChips()}
    async function saveGrp(){
      const g={id:$('g-id').value.trim(),name:$('g-nm').value.trim()||$('g-id').value.trim(),cfToken:$('g-tk').value,zoneId:$('g-zn').value,domain:$('g-dm').value,recordType:$('g-rt').value||'TXT',resolveCount:+$('g-ct').value||8,fofaQuery:$('g-fofa-q').value.trim(),fofaSize:+$('g-fofa-sz').value||10000,fofaCron:$('g-fofa-cron').value||'',selectedAsns:[...GA]};
      if(!g.id)return tt('需要分组ID',0);
      try{await api('/api/groups',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(g)});tt('分组已保存');clrGF();loadGrps()}catch(e){tt(e.message,0)}
    }
    async function delGrp(id){if(!confirm('删除分组'+id+'及其所有IP？'))return;try{await api('/api/delete-group',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id})});tt('已删除');if(CG===id){CG='';$('ip-grp').value='';$('ip-panel').classList.add('hid')}loadGrps()}catch(e){tt(e.message,0)}}
    async function resGrp(id,b){dis(b,1);try{const r=await api('/api/resolve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({groupId:id})});tt('已解析: '+r.resolved.join(', '));loadSt()}catch(e){tt(e.message,0)}finally{dis(b,0)}}
    async function fofaSearch(id,b){if(!confirm('确认使用FOFA搜索？搜索到的IP将保存到列表并自动触发Actions检测'))return;dis(b,1);try{const r=await api('/api/fofa-search',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({groupId:id})});tt(r.msg);if(r.added>0&&CG===id)chgGrp()}catch(e){tt(e.message,0)}finally{dis(b,0)}}

    // 触发GitHub Actions
    async function triggerActions(b){
      dis(b,1);
      try{
        await api('/api/trigger-actions',{method:'POST'});
        tt('GitHub Actions已触发，请稍后查看结果');
      }catch(e){
        tt(e.message,0);
      }finally{
        dis(b,0);
      }
    }

    // 设置
    async function loadCfg(){try{const c=await api('/api/config');$('c-gh-token').value=c.githubToken||'';$('c-gh-repo').value=c.githubRepo||'';$('c-tt').value=c.tgToken||'';$('c-tc').value=c.tgChatId||'';$('c-fofa-key').value=c.fofaKey||''}catch{}}
    async function saveCfg(){
      const c={githubToken:$('c-gh-token').value,githubRepo:$('c-gh-repo').value,tgToken:$('c-tt').value,tgChatId:$('c-tc').value,fofaKey:$('c-fofa-key').value};
      const pw=$('c-pw').value;if(pw){c.password=pw;P=pw;localStorage.setItem('_pp',pw)}
      try{await api('/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(c)});tt('设置已保存');$('c-pw').value='';loadSt()}catch(e){tt(e.message,0)}
    }
    async function loadBL(){try{const b=await api('/api/blacklist');$('blt').value=b.join('\\x0a')}catch{}}
    async function saveBL(){
      const b=$('blt').value.split('\\x0a').map(s=>s.trim()).filter(Boolean);
      try{await api('/api/blacklist',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({blacklist:b})});tt('黑名单已保存');loadSt()}catch(e){tt(e.message,0)}
    }
    // 回收站
    async function loadTrash(){
      TG=$('trash-grp').value;
      if(!TG){$('trash-c').textContent='';$('tb-trash').innerHTML='';return}
      try{
        TRASH=await api('/api/trash?groupId='+TG);
        $('trash-c').textContent='('+TRASH.length+'条)';
        $('tb-trash').innerHTML=TRASH.map(i=>'<tr><td><input type="checkbox" class="ck-trash" value="'+i.ipPort+'"></td><td>'+i.ipPort+'</td><td>AS'+i.asn+'</td><td>'+i.country+'</td><td style="color:var(--rd);font-size:11px">'+i.deletedReason+'</td><td style="color:var(--dm);font-size:11px">'+new Date(i.deletedAt).toLocaleString()+'</td></tr>').join('');
      }catch(e){
        console.error('加载回收站失败:',e);
        $('trash-c').textContent='(加载失败)';
        $('tb-trash').innerHTML='<tr><td colspan="6" style="text-align:center;color:var(--rd)">'+e.message+'</td></tr>';
      }
    }
    function togATrash(e){document.querySelectorAll('.ck-trash').forEach(c=>c.checked=e.checked)}
    function selATrash(){document.querySelectorAll('.ck-trash').forEach(c=>c.checked=true);if($('ca-trash'))$('ca-trash').checked=true}
    function getSelTrash(){return[...document.querySelectorAll('.ck-trash:checked')].map(c=>c.value)}
    async function restoreTrash(){
      const s=getSelTrash();if(!s.length)return tt('请先选择',0);
      if(!TG)return tt('请先选择分组',0);
      const g=GRPS.find(x=>x.id===TG);
      if(!confirm('恢复'+s.length+'条IP到分组['+g.name+']？'))return;
      try{await api('/api/restore',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ipPorts:s,groupId:TG})});tt('已恢复'+s.length+'条');loadTrash();if(CG===TG)chgGrp()}catch(e){tt(e.message,0)}
    }
    async function clearTrash(){
      if(!TG)return tt('请先选择分组',0);
      if(!confirm('确认清空该分组的回收站？'))return;
      try{await api('/api/trash?groupId='+TG,{method:'DELETE'});tt('回收站已清空');loadTrash()}catch(e){tt(e.message,0)}
    }
    init();
    </script></body></html>`;

    export default{
      async fetch(request,env,ctx){
        const p=new URL(request.url).pathname;
        if(p==='/'||p==='')return new Response(HTML,{headers:{'Content-Type':'text/html;charset=utf-8'}});
        if(p.startsWith('/api/')){try{return await handleAPI(p,request,env,ctx)}catch(e){return json({error:e.message},500)}}
        return new Response('Not Found',{status:404});
      },
      async scheduled(event,env,ctx){
        ctx.waitUntil(scheduledFofaSearch(env));
      }
    };
