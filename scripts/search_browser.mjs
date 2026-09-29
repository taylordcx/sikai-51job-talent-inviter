import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { pageOperation } from './search_dom.mjs';

export function chooseTarget(targets, id) {
  const matches = targets.filter(t => {
    try {
      const u = new URL(t.url);
      return t.type === 'page' && u.protocol === 'https:' &&
        ['ehire.51job.com','mall.51job.com'].includes(u.hostname) &&
        ['/Revision/talent/search','/Revision/online/talent/search'].includes(u.pathname) && (!id || t.id === id);
    } catch { return false; }
  });
  if (matches.length !== 1) throw new Error('需要唯一的人才搜索标签页；多个页面时请指定 --target');
  return matches[0];
}

export async function connect(port=9222, targetId) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('端口无效');
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, {signal:AbortSignal.timeout(5000)});
  if (!res.ok) throw new Error('无法读取招聘浏览器标签页');
  const target = chooseTarget(await res.json(), targetId);
  return attach(target,port);
}

export async function attach(target,port) {
  const url = new URL(target.webSocketDebuggerUrl);
  if (!['127.0.0.1','localhost'].includes(url.hostname) || url.protocol !== 'ws:' || Number(url.port) !== port)
    throw new Error('拒绝非本机调试连接');
  const ws = new WebSocket(url);
  const pending = new Map();
  let sequence=0;
  ws.addEventListener('message', event => {
    let msg;
    try { msg=JSON.parse(event.data); } catch { return; }
    const item=pending.get(msg.id);
    if (!item) return;
    pending.delete(msg.id); clearTimeout(item.timer);
    msg.error ? item.reject(new Error(msg.error.message)) : item.resolve(msg.result);
  });
  ws.addEventListener('close', () => {
    for (const item of pending.values()) {clearTimeout(item.timer); item.reject(new Error('浏览器连接已关闭'));}
    pending.clear();
  });
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{ws.close();reject(new Error('浏览器连接超时'));},5000);
    ws.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});
    ws.addEventListener('error',()=>{clearTimeout(timer);reject(new Error('浏览器连接失败'));},{once:true});
  });
  function command(method,params={}) {
    return new Promise((resolve,reject)=>{
      const id=++sequence;
      const timer=setTimeout(()=>{pending.delete(id);reject(new Error('页面操作超时，未自动重试'));},12000);
      pending.set(id,{resolve,reject,timer});
      try {ws.send(JSON.stringify({id,method,params}));} catch(e) {pending.delete(id);clearTimeout(timer);reject(e);}
    });
  }
  return {
    targetId:target.id,
    async evaluate(expression) {
      const result = await command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result?.value;
    },
    command,
    close(){ws.close();}
  };
}

export function createBrowser(client) {
  const call=(op,args={})=>client.evaluate(`(${pageOperation.toString()})(${JSON.stringify(op)},${JSON.stringify(args)})`);
  const pause=ms=>new Promise(r=>setTimeout(r,ms));
  async function click(op,args={}) {
    const p=await call(op,args);
    await client.command('Input.dispatchMouseEvent',{type:'mouseMoved',...p});
    await client.command('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...p});
    await client.command('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...p});
    await pause(350);
  }
  async function openJobs(){
    if(!await call('jobs-menu-open'))await click('jobs-open');
    const deadline=Date.now()+6000;
    while(Date.now()<deadline){if(await call('has-jobs'))return;await pause(150);}
    throw Error('岗位下拉尚未加载完成，已停止；未重复点击');
  }
  async function waitReady(){
    const deadline=Date.now()+15000;
    while(true){
      const r=await call('readiness');
      if(r.blocked)throw Error('存在实际弹窗遮挡，请处理后继续');
      if(!r.loading)return;
      if(Date.now()>=deadline)throw Error('页面加载超过15秒，尚未就绪；未重复点击');
      await pause(250);
    }
  }
  async function waitCities(expected){
    const deadline=Date.now()+6000;
    while(true){
      if(JSON.stringify(await call('city-values'))===JSON.stringify([...expected].sort()))return;
      if(Date.now()>=deadline)throw Error('城市选择尚未生效：'+expected.join('+'));
      await pause(150);
    }
  }
  return {
    async read(){
      await waitReady();
      await openJobs();
      let state;
      try {state=await call('state');}
      finally {await click('dismiss-jobs');}
      // The job menu may itself be loading. Judge readiness after dismissing it.
      await waitReady();
      const readiness=await call('readiness');
      return {...state,...readiness};
    },
    async selectJob(key){await openJobs();await click('job',{key});},
    async setFilter(field,value){
      if(field==='keywords'){
        await call('keyword-focus');
        await client.command('Input.insertText',{text:value===null?'':value});
        await pause(500);return;
      }
      if(field==='desired_locations'){
        const desired=[...(value||[])].sort();
        await click('city-open');
        let committed=false;
        try {
          const current=await call('city-values');
          let selected=[...current];
          for(const city of current.filter(c=>!desired.includes(c))){await click('city-remove',{value:city});selected=selected.filter(c=>c!==city);await waitCities(selected);}
          for(const city of desired.filter(c=>!current.includes(c))){
            await call('city-input');await client.command('Input.insertText',{text:city});await pause(700);
            const deadline=Date.now()+6000;
            while(true){try{await call('city-option',{value:city});break;}catch(e){if(Date.now()>=deadline)throw e;await pause(150);}}
            await click('city-option',{value:city});
            selected.push(city);await waitCities(selected);
          }
          if(JSON.stringify(await call('city-values'))!==JSON.stringify(desired))throw Error('地点弹窗选择值不一致');
          await click('city-confirm');committed=true;
        } finally {if(!committed)await click('city-close');}
        return;
      }
      if(!['experience','education'].includes(field))throw Error('此字段的网页控件尚未核实：'+field);
      await click('field-open',{field});await click('field-option',{field,value});
    },
    async search(){await click('search');await pause(1500);return {confirmed:false};}
  };
}

const INSPECT = `(() => ({
  url:location.origin+location.pathname,
  form:document.querySelector('.code_filter')?.outerHTML.slice(0,140000),
  jobPanels:Array.from(document.querySelectorAll('div,span')).filter(e=>!e.children.length&&e.textContent.trim()==='搜索词匹配职位').map(e=>e.parentElement.outerHTML.slice(0,50000)),
  searchParams:document.querySelector('.search_params')?.outerHTML.slice(0,200000),
  nearFilters:Array.from(document.querySelector('.search_params')?.parentElement?.children||[]).map(e=>({tag:e.tagName,class:e.className})),
  activeAnchors:Array.from(document.querySelectorAll('div,span')).filter(e=>!e.children.length&&/最近活跃|活跃时间/.test(e.textContent)&&e.textContent.length<50).map(e=>e.parentElement.outerHTML.slice(0,10000)),
  popups:Array.from(document.querySelectorAll('.el-popover,.el-select-dropdown,.el-dialog,.el-popper')).filter(e=>e.getBoundingClientRect().width>0&&getComputedStyle(e).visibility!=='hidden').map(e=>e.outerHTML.slice(0,70000)),
  filterAnchors:Array.from(document.querySelectorAll('div,span,label')).filter(e=>!e.children.length&&['基础信息','期望/经历','学历','工作年限','3–5年','3—5年','3-5年','更多筛选','清空筛选'].includes(e.textContent.trim())).map(e=>({text:e.textContent.trim(),parent:e.parentElement.outerHTML.slice(0,15000),ancestors:(()=>{let n=e;let a=[];for(let i=0;n&&i<5;i++,n=n.parentElement)a.push(n.className);return a;})()})),
  inputs:Array.from(document.querySelectorAll('input')).filter(e=>!['password','hidden','checkbox','radio'].includes(e.type)&&e.getBoundingClientRect().width>0).map(e=>({placeholder:e.getAttribute('placeholder'),type:e.type,html:e.outerHTML,parent:e.parentElement.outerHTML.slice(0,4500)})),
  keywordContainer:document.querySelector('.talent_search_keywords_input')?.parentElement?.outerHTML.slice(0,24000),
  ancestors:(()=>{let e=document.querySelector('.talent_search_keywords_input');const out=[];for(let i=0;e&&i<7;i++,e=e.parentElement)out.push({tag:e.tagName,class:e.className});return out;})()
}))()`;

async function main() {
  const args=process.argv.slice(2);
  if (!['inspect','calibrate-jobs','calibrate-address','close-address','state','serve'].includes(args[0])) throw new Error('当前命令：state / serve / inspect');
  const value=(flag,fallback)=>args.includes(flag)?args[args.indexOf(flag)+1]:fallback;
  const client=await connect(Number(value('--port',9222)),value('--target',undefined));
  try {
    const browser=createBrowser(client);
    if(args[0]==='state'){console.log(JSON.stringify(await browser.read(),null,2));return;}
    if(args[0]==='serve'){
      for await(const line of createInterface({input:process.stdin,crlfDelay:Infinity})){
        try {
          const msg=JSON.parse(line);let result;
          if(msg.op==='read')result=await browser.read();
          else if(msg.op==='job')result=await browser.selectJob(msg.key);
          else if(msg.op==='filter')result=await browser.setFilter(msg.field,msg.value);
          else if(msg.op==='search')result=await browser.search();
          else throw Error('不支持的搜索动作');
          console.log(JSON.stringify({ok:true,result:result??null}));
        }catch(e){console.log(JSON.stringify({ok:false,error:e.message}));}
      }
      return;
    }
    const closeAddress=()=>client.evaluate(`(()=>{const ds=Array.from(document.querySelectorAll('.el-dialog')).filter(e=>e.getBoundingClientRect().width>0&&e.querySelector('.eh_cascader_dialog_title')?.textContent.trim()==='选择城市');if(ds.length!==1)throw Error('无法确认地点弹窗');const b=ds[0].querySelector('.el-dialog__headerbtn');if(!b)throw Error('无法确认关闭按钮');b.click();return true;})()`);
    if(args[0]==='close-address'){await closeAddress();console.log(JSON.stringify({status:'closed'}));return;}
    if (args[0].startsWith('calibrate-')) {
      const selector=args[0]==='calibrate-jobs'?'.code_filter .cur_selected_job_tag_content':'.code_filter .outer_search_address';
      const p=await client.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('未找到指定搜索控件');const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
      await client.command('Input.dispatchMouseEvent',{type:'mouseMoved',...p});
      await client.command('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...p});
      await client.command('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...p});
      await new Promise(r=>setTimeout(r,700));
    }
    console.log(JSON.stringify({target_id:client.targetId,...await client.evaluate(INSPECT)},null,2));
    if (args[0] === 'calibrate-jobs') await client.evaluate(`(()=>{document.querySelector('.search-row-label')?.click();return true;})()`);
    if (args[0] === 'calibrate-address') await closeAddress();
  }
  finally {client.close();}
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(e=>{console.error(JSON.stringify({status:'stopped',error:e.message}));process.exitCode=1;});
