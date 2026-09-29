import {existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {attach} from './search_browser.mjs';

const SEARCH = 'https://ehire.51job.com/Revision/talent/search';
const pause = ms => new Promise(r => setTimeout(r, ms));

export function launchCommand(port, home=homedir(), platform=process.platform, exists=existsSync, env=process.env, uid=process.getuid?.()) {
  if (!['darwin','win32','linux'].includes(platform)) throw Error('不支持当前系统自动启动，请使用平台提供的可见浏览器工具');
  if (platform==='linux') {
    if (!env.DISPLAY?.trim() && !env.WAYLAND_DISPLAY?.trim())
      throw Error('当前Linux运行环境缺少桌面显示环境（DISPLAY / WAYLAND_DISPLAY），无法启动可见浏览器。请在有桌面的本地电脑运行技能，或使用平台提供的可见浏览器连接；延长等待无效，未尝试headless或关闭沙箱。');
    if (uid===0)
      throw Error('当前以root运行，技能不通过--no-sandbox启动Chrome。请改在普通用户的桌面会话运行，或使用平台提供的可见浏览器连接。');
  }
  const profiles = ['.job51_talent_searcher/edge_profile', '.51job-talent-inviter/browser-profile'];
  const profile = profiles.map(p=>join(home,p)).find(exists) || join(home,'.51job-talent-inviter/browser-profile');
  const candidates = platform==='darwin' ? [
    '/Applications/Google Chrome.app', join(home,'Applications/Google Chrome.app'), '/Applications/Microsoft Edge.app'
  ] : platform==='win32' ? [
    ...['PROGRAMFILES','PROGRAMFILES(X86)','LOCALAPPDATA'].flatMap(k=>env[k] ? [join(env[k],'Google/Chrome/Application/chrome.exe'),join(env[k],'Microsoft/Edge/Application/msedge.exe')] : [])
  ] : ['/usr/bin/google-chrome','/usr/bin/chromium','/usr/bin/chromium-browser','/usr/bin/microsoft-edge'];
  const executable=candidates.find(exists);
  if (!executable) throw Error('未找到Chrome或Edge，请先安装或使用现有浏览器工具打开招聘页');
  const flags=[`--remote-debugging-address=127.0.0.1`,`--remote-debugging-port=${port}`,`--user-data-dir=${profile}`,'--no-first-run','--no-default-browser-check',SEARCH];
  return platform==='darwin' ? ['open',['-na',executable,'--args',...flags]] : [executable,flags];
}

export async function ensureBrowser(port, io) {
  if(!Number.isInteger(port)||port<1024||port>65535) throw Error('端口无效');
  let targets=await io.list();
  const launched=targets===null;
  if(launched) {
    await io.launch();
    for(let n=0;n<30;n++) {
      await io.pause(500);
      targets=await io.list();
      if(targets!==null) break;
    }
    if(targets===null) throw Error('浏览器启动后仍未连接，请检查系统启动权限或端口；未重复启动');
  }
  if(!Array.isArray(targets)) throw Error('调试端口返回异常，已停止');
  const matches=targets.filter(t=>{
    try {const u=new URL(t.url);return t.type==='page'&&u.protocol==='https:'&&['ehire.51job.com','mall.51job.com'].includes(u.hostname);}catch{return false;}
  });
  if(matches.length>1) throw Error('有多个招聘标签页，请在浏览器中选择要操作的页面；未自动切换');
  const target=matches[0] || await io.create();
  await io.show(target);
  return {status:'browser_ready',launched,target_id:target.id,url:new URL(target.url).origin+new URL(target.url).pathname,contacted:0,message:'浏览器已打开并显示招聘页面；若页面要求登录，请手动登录。尚未搜索或邀约。'};
}

async function main() {
  const args=process.argv.slice(2);
  const port=args.length===0?9222:Number(args[1]);
  if(args.length && (args[0]!=='--port'||args.length!==2)) throw Error('用法：node start_browser.mjs [--port 9222]');
  const base=`http://127.0.0.1:${port}`;
  async function request(path,method='GET') {
    const response=await fetch(base+path,{method,signal:AbortSignal.timeout(1500)});
    if(!response.ok) throw Error('浏览器调试端口响应异常：'+response.status);
    return response.json();
  }
  const result=await ensureBrowser(port,{
    async list(){try{return await request('/json/list');}catch(e){if(e.cause?.code==='ECONNREFUSED')return null;throw e;}},
    async launch(){
      const [exe,argv]=launchCommand(port);
      await new Promise((resolve,reject)=>{
        const child=spawn(exe,argv,{stdio:'ignore',detached:process.platform!=='darwin'});
        child.once('error',reject);
        if(process.platform==='darwin')child.once('exit',code=>code===0?resolve():reject(Error('系统拒绝启动浏览器')));
        else child.once('spawn',()=>{child.unref();resolve();});
      });
    },
    pause,
    create:()=>request('/json/new?'+encodeURIComponent(SEARCH),'PUT'),
    async show(target){
      const c=await attach(target,port);
      try{
        const {windowId}=await c.command('Browser.getWindowForTarget',{targetId:target.id});
        await c.command('Browser.setWindowBounds',{windowId,bounds:{windowState:'normal'}});
        await c.command('Page.bringToFront');
      }finally{c.close();}
    }
  });
  console.log(JSON.stringify(result,null,2));
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href)
  main().catch(e=>{console.error(JSON.stringify({status:'stopped',error:e.message}));process.exitCode=2;});
